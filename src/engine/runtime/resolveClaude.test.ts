import { describe, expect, test } from 'vitest'
import { execFileNode, resolveClaude, type ExecFn } from './resolveClaude'

type Result = { code: number; stdout: string; stderr: string }
const ok = (stdout: string): Result => ({ code: 0, stdout, stderr: '' })

/** A fake ExecFn keyed on `file args...`; anything unlisted fails like a missing program. */
function fakeExec(table: Record<string, Result | Error>): { exec: ExecFn; calls: string[] } {
  const calls: string[] = []
  const exec: ExecFn = async (file, args) => {
    const key = [file, ...args].join(' ')
    calls.push(key)
    const r = table[key]
    if (r instanceof Error) throw r
    return r ?? { code: 1, stdout: '', stderr: 'not found' }
  }
  return { exec, calls }
}

const EXE = 'C:\\Users\\x\\.local\\bin\\claude.exe'
/** No native-install fallback: keeps the not_found tests independent of the machine they run on. */
const NO_FALLBACK = { exists: () => false, home: 'C:\\Users\\x', list: () => [] }

describe('resolveClaude', () => {
  test('not_found when where.exe fails', async () => {
    const { exec } = fakeExec({ 'where.exe claude': { code: 1, stdout: '', stderr: 'INFO: Could not find files' } })
    const r = await resolveClaude(exec, 'win32', NO_FALLBACK)
    expect(r).toMatchObject({ ok: false, reason: 'not_found' })
  })

  test('not_found when the lookup cannot even be spawned', async () => {
    const { exec } = fakeExec({ 'where.exe claude': new Error('spawn where.exe ENOENT') })
    const r = await resolveClaude(exec, 'win32', NO_FALLBACK)
    expect(r).toMatchObject({ ok: false, reason: 'not_found' })
  })

  test('not_found when where.exe only finds a .cmd shim', async () => {
    const { exec } = fakeExec({ 'where.exe claude': ok('C:\\x\\claude.cmd\r\n') })
    const r = await resolveClaude(exec, 'win32', NO_FALLBACK)
    expect(r).toMatchObject({ ok: false, reason: 'not_found' })
  })

  describe('native installer fallback', () => {
    const home = 'C:\\Users\\x'
    const ready = {
      [`${EXE} --version`]: ok('2.1.314 (Claude Code)'),
      [`${EXE} auth status`]: ok('ok')
    }
    const missing = { 'where.exe claude': { code: 1, stdout: '', stderr: 'INFO: Could not find files' } }

    test('uses ~\\.local\\bin\\claude.exe when PATH has no claude', async () => {
      const { exec } = fakeExec({ ...missing, ...ready })
      const r = await resolveClaude(exec, 'win32', { exists: (p) => p === EXE, home })
      expect(r).toEqual({ ok: true, path: EXE, version: '2.1.314' })
    })

    test('uses it when PATH only has a .cmd shim', async () => {
      const { exec } = fakeExec({ 'where.exe claude': ok('C:\\x\\claude.cmd'), ...ready })
      const r = await resolveClaude(exec, 'win32', { exists: (p) => p === EXE, home })
      expect(r).toMatchObject({ ok: true, path: EXE })
    })

    test('a claude.exe on PATH wins over the fallback', async () => {
      const onPath = 'D:\\tools\\claude.exe'
      const { exec } = fakeExec({
        'where.exe claude': ok(onPath),
        [`${onPath} --version`]: ok('2.1.314 (Claude Code)'),
        [`${onPath} auth status`]: ok('ok')
      })
      const r = await resolveClaude(exec, 'win32', { exists: () => true, home })
      expect(r).toMatchObject({ ok: true, path: onPath })
    })

    test('not_found when the fallback file is absent too', async () => {
      const { exec } = fakeExec(missing)
      expect(await resolveClaude(exec, 'win32', { exists: () => false, home })).toMatchObject({
        ok: false,
        reason: 'not_found'
      })
    })

    test('the Windows fallback ignores the POSIX folders', async () => {
      const { exec } = fakeExec(missing)
      const r = await resolveClaude(exec, 'win32', {
        exists: (p) => p === '/usr/local/bin/claude',
        home,
        list: () => []
      })
      expect(r).toMatchObject({ ok: false, reason: 'not_found' })
    })
  })

  describe('macOS and Linux install locations', () => {
    const home = '/home/x'
    const noWhich = { 'which claude': { code: 1, stdout: '', stderr: '' } }
    const ready = (p: string) => ({ [`${p} --version`]: ok('2.1.314 (Claude Code)'), [`${p} auth status`]: ok('ok') })
    const locations: [string, string, NodeJS.Platform][] = []
    for (const platform of ['darwin', 'linux'] as const) {
      for (const p of [
        '/home/x/.local/bin/claude',
        '/home/x/.claude/local/claude',
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        '/home/x/.npm-global/bin/claude',
        '/home/x/.volta/bin/claude',
        '/home/x/.nvm/versions/node/v22.1.0/bin/claude'
      ]) {
        locations.push([platform, p, platform])
      }
    }
    locations.push(['linux', '/home/linuxbrew/.linuxbrew/bin/claude', 'linux'])

    test.each(locations)('%s: finds %s when which finds nothing', async (_n, path, platform) => {
      const { exec } = fakeExec({ ...noWhich, ...ready(path) })
      const r = await resolveClaude(exec, platform, {
        exists: (p) => p === path,
        home,
        list: (d) => (d === '/home/x/.nvm/versions/node' ? ['v22.1.0'] : [])
      })
      expect(r).toEqual({ ok: true, path, version: '2.1.314' })
    })

    test('which wins over the fallbacks', async () => {
      const { exec } = fakeExec({ 'which claude': ok('/bin/claude'), ...ready('/bin/claude') })
      const r = await resolveClaude(exec, 'linux', { exists: () => true, home, list: () => [] })
      expect(r).toMatchObject({ ok: true, path: '/bin/claude' })
    })

    test('uses the newest nvm Node', async () => {
      const newest = '/home/x/.nvm/versions/node/v20.11.0/bin/claude'
      const { exec } = fakeExec({ ...noWhich, ...ready(newest) })
      const only = await resolveClaude(exec, 'darwin', {
        exists: (p) => p === newest,
        home,
        list: () => ['v9.0.0', 'v20.11.0', 'junk']
      })
      expect(only).toMatchObject({ ok: true, path: newest })
    })

    test('not_found when nothing exists', async () => {
      const { exec } = fakeExec(noWhich)
      expect(await resolveClaude(exec, 'linux', { exists: () => false, home, list: () => [] })).toMatchObject({
        ok: false,
        reason: 'not_found'
      })
    })
  })

  test('not_logged_in when auth status exits non-zero', async () => {
    const { exec } = fakeExec({
      'where.exe claude': ok(`${EXE}\r\n`),
      [`${EXE} --version`]: ok('2.1.314 (Claude Code)\r\n'),
      [`${EXE} auth status`]: { code: 1, stdout: '', stderr: 'Not logged in' }
    })
    const r = await resolveClaude(exec, 'win32')
    expect(r).toMatchObject({ ok: false, reason: 'not_logged_in' })
    expect(r.ok === false && r.detail).toContain('Not logged in')
  })

  test('ok with path and version', async () => {
    const { exec } = fakeExec({
      'where.exe claude': ok(`${EXE}\r\n`),
      [`${EXE} --version`]: ok('2.1.314 (Claude Code)\r\n'),
      [`${EXE} auth status`]: ok('{"loggedIn":true}')
    })
    expect(await resolveClaude(exec, 'win32')).toEqual({ ok: true, path: EXE, version: '2.1.314' })
  })

  test('picks the .exe when where.exe prints several matches', async () => {
    const { exec } = fakeExec({
      'where.exe claude': ok('C:\\x\\claude\r\nC:\\x\\claude.cmd\r\nC:\\x\\claude.exe\r\n'),
      'C:\\x\\claude.exe --version': ok('2.1.314 (Claude Code)'),
      'C:\\x\\claude.exe auth status': ok('ok')
    })
    expect(await resolveClaude(exec, 'win32')).toEqual({ ok: true, path: 'C:\\x\\claude.exe', version: '2.1.314' })
  })

  test('uses which off Windows and takes the first line', async () => {
    const { exec, calls } = fakeExec({
      'which claude': ok('/usr/local/bin/claude\n/opt/claude\n'),
      '/usr/local/bin/claude --version': ok('2.1.314 (Claude Code)\n'),
      '/usr/local/bin/claude auth status': ok('ok')
    })
    expect(await resolveClaude(exec, 'linux')).toEqual({ ok: true, path: '/usr/local/bin/claude', version: '2.1.314' })
    expect(calls[0]).toBe('which claude')
  })

  test('not_found when --version prints nothing parseable', async () => {
    const { exec } = fakeExec({
      'where.exe claude': ok(`${EXE}\r\n`),
      [`${EXE} --version`]: ok('garbage')
    })
    expect(await resolveClaude(exec, 'win32')).toMatchObject({ ok: false, reason: 'not_found' })
  })
})

describe('execFileNode', () => {
  test('runs a program without a shell and reports its exit code and output', async () => {
    const r = await execFileNode(process.execPath, ['-e', 'process.stdout.write("hi"); process.exit(3)'])
    expect(r).toEqual({ code: 3, stdout: 'hi', stderr: '' })
  })
})
