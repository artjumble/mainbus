import { describe, expect, test } from 'vitest'
import {
  applyLoginShellPath,
  defaultShellRunner,
  loginShellPath,
  parseMarkedPath,
  wellKnownBinDirs,
  type DirFs,
  type ShellResult,
  type ShellRunner
} from './shellPath'

const M = '@@M@@'
const home = '/Users/x'

function fsOf(existing: string[], nvm: string[] = []): DirFs {
  return {
    exists: (p) => existing.includes(p),
    list: (d) => (d === '/Users/x/.nvm/versions/node' ? nvm : [])
  }
}

function runner(result: ShellResult): { run: ShellRunner; calls: { shell: string; args: string[]; ms: number }[] } {
  const calls: { shell: string; args: string[]; ms: number }[] = []
  return {
    calls,
    run: async (shell, args, ms) => {
      calls.push({ shell, args, ms })
      return result
    }
  }
}

const base = { platform: 'darwin' as const, env: { PATH: '/usr/bin:/bin' }, home, shell: '/bin/zsh', marker: M }

describe('parseMarkedPath', () => {
  test('ignores banners, trailing newlines and carriage returns', () => {
    expect(parseMarkedPath(`Welcome!\r\n${M}/a:/b\r\n${M}\nbye`, M)).toBe('/a:/b')
  })
  test('null when a marker is missing or the text is empty', () => {
    expect(parseMarkedPath(`${M}/a:/b`, M)).toBeNull()
    expect(parseMarkedPath('nothing', M)).toBeNull()
    expect(parseMarkedPath(`${M}  ${M}`, M)).toBeNull()
  })
})

describe('wellKnownBinDirs', () => {
  test('returns only existing folders, in order, with the newest nvm Node', () => {
    const nvm = '/Users/x/.nvm/versions/node/v20.11.0/bin'
    const dirs = wellKnownBinDirs(
      home,
      fsOf(['/usr/local/bin', '/Users/x/.local/bin', nvm], ['v9.0.0', 'v20.11.0', 'weird']),
      'darwin'
    )
    expect(dirs).toEqual(['/Users/x/.local/bin', '/usr/local/bin', nvm])
  })
  test('a missing nvm folder is fine, and linuxbrew is Linux only', () => {
    const lb = '/home/linuxbrew/.linuxbrew/bin'
    expect(wellKnownBinDirs(home, fsOf([lb]), 'linux')).toEqual([lb])
    expect(wellKnownBinDirs(home, fsOf([lb]), 'darwin')).toEqual([])
  })
  test('never throws', () => {
    const bad: DirFs = {
      exists: () => {
        throw new Error('x')
      },
      list: () => {
        throw new Error('y')
      }
    }
    expect(wellKnownBinDirs(home, bad, 'linux')).toEqual([])
  })
})

describe('loginShellPath', () => {
  test('uses the PATH from the login shell, merged with the current one', async () => {
    const { run, calls } = runner({ kind: 'ok', stdout: `${M}/opt/homebrew/bin:/usr/bin${M}` })
    const r = await loginShellPath({ ...base, run, fs: fsOf([]) })
    expect(r).toEqual({ source: 'shell', path: '/opt/homebrew/bin:/usr/bin:/bin' })
    expect(calls).toHaveLength(1)
    expect(calls[0].shell).toBe('/bin/zsh')
    expect(calls[0].args[0]).toBe('-ilc')
    expect(calls[0].args[1]).toContain(M)
    expect(calls[0].ms).toBe(3000)
  })
  test('noisy dotfile output is ignored', async () => {
    const { run } = runner({ kind: 'ok', stdout: `motd\r\nhello\r\n${M}/p/bin\r\n${M}\r\nfortune: stay calm\n` })
    expect((await loginShellPath({ ...base, run, fs: fsOf([]) })).path).toBe('/p/bin:/usr/bin:/bin')
  })
  test('a timeout falls back to the existing well-known folders in front', async () => {
    const { run } = runner({ kind: 'timeout' })
    const r = await loginShellPath({ ...base, run, fs: fsOf(['/opt/homebrew/bin']) })
    expect(r.source).toBe('fallback')
    expect(r.path).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(r.reason).toMatch(/timed out/)
  })
  test('a runner error falls back', async () => {
    const { run } = runner({ kind: 'error', message: 'spawn ENOENT' })
    const r = await loginShellPath({ ...base, run, fs: fsOf(['/usr/local/bin']) })
    expect(r).toMatchObject({ source: 'fallback', path: '/usr/local/bin:/usr/bin:/bin', reason: 'spawn ENOENT' })
  })
  test('a missing end marker falls back', async () => {
    const { run } = runner({ kind: 'ok', stdout: `${M}/p/bin` })
    expect((await loginShellPath({ ...base, run, fs: fsOf([]) })).source).toBe('fallback')
  })
  test('fallback does not duplicate folders already on PATH', async () => {
    const { run } = runner({ kind: 'timeout' })
    const r = await loginShellPath({ ...base, env: { PATH: '/usr/local/bin:/bin' }, run, fs: fsOf(['/usr/local/bin']) })
    expect(r.path).toBe('/usr/local/bin:/bin')
  })
  test('does nothing on win32', async () => {
    const { run, calls } = runner({ kind: 'timeout' })
    const r = await loginShellPath({ ...base, platform: 'win32', run, fs: fsOf([]) })
    expect(r).toEqual({ source: 'unchanged', path: '/usr/bin:/bin' })
    expect(calls).toHaveLength(0)
  })
  test('does nothing when started from a terminal', async () => {
    const { run, calls } = runner({ kind: 'timeout' })
    const r = await loginShellPath({ ...base, env: { PATH: '/x', TERM: 'xterm' }, run, fs: fsOf([]) })
    expect(r.source).toBe('unchanged')
    expect(calls).toHaveLength(0)
  })
})

describe('applyLoginShellPath', () => {
  test('writes env.PATH', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', SHELL: '/bin/bash', HOME: home }
    const { run, calls } = runner({ kind: 'ok', stdout: 'x' })
    const marked: ShellRunner = async (shell, args, ms) => {
      const marker = /'(__MAINBUS_PATH_[^']+)'/.exec(args[1])![1]
      await run(shell, args, ms)
      return { kind: 'ok', stdout: `${marker}/mine/bin:/usr/bin${marker}` }
    }
    await applyLoginShellPath(env, { platform: 'linux', run: marked, fs: fsOf([]) })
    expect(env.PATH).toBe('/mine/bin:/usr/bin')
    expect(calls[0].shell).toBe('/bin/bash')
  })
  test('leaves env alone on win32', async () => {
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\x' }
    const { run, calls } = runner({ kind: 'timeout' })
    await applyLoginShellPath(env, { platform: 'win32', run })
    expect(env.PATH).toBe('C:\\x')
    expect(calls).toHaveLength(0)
  })
})

describe.skipIf(process.platform === 'win32')('defaultShellRunner', () => {
  test('times out a shell that hangs', async () => {
    expect(await defaultShellRunner('/bin/sh', ['-c', 'sleep 10'], 200)).toEqual({ kind: 'timeout' })
  })
  test('returns stdout', async () => {
    expect(await defaultShellRunner('/bin/sh', ['-c', 'printf hi'], 2000)).toEqual({ kind: 'ok', stdout: 'hi' })
  })
})
