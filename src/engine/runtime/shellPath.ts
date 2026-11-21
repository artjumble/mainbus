import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { posix } from 'node:path'

/** What the PATH lookups look at; injectable so tests don't depend on the machine. */
export interface DirFs {
  exists: (path: string) => boolean
  /** Names inside a folder; `[]` when it can't be read. */
  list: (dir: string) => string[]
}

export const defaultDirFs: DirFs = {
  exists: existsSync,
  list: (dir) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
}

function versionParts(name: string): number[] | null {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(name)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function newestNvmBin(home: string, fs: DirFs): string | null {
  const root = posix.join(home, '.nvm', 'versions', 'node')
  let names: string[]
  try {
    names = fs.list(root)
  } catch {
    return null
  }
  let best: { name: string; v: number[] } | null = null
  for (const name of names) {
    const v = versionParts(name)
    if (!v) continue
    if (!best || v[0] > best.v[0] || (v[0] === best.v[0] && (v[1] > best.v[1] || (v[1] === best.v[1] && v[2] > best.v[2])))) {
      best = { name, v }
    }
  }
  return best ? posix.join(root, best.name, 'bin') : null
}

/** Folders where `claude`, `gh`, `node` and friends are commonly installed on macOS and Linux, that exist. Never throws. */
export function wellKnownBinDirs(home: string, fs: DirFs, platform: NodeJS.Platform, onlyExisting = true): string[] {
  const candidates = [
    posix.join(home, '.local', 'bin'),
    posix.join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(platform === 'linux' ? ['/home/linuxbrew/.linuxbrew/bin'] : []),
    posix.join(home, '.npm-global', 'bin'),
    posix.join(home, '.volta', 'bin')
  ]
  const nvm = newestNvmBin(home, fs)
  if (nvm) candidates.push(nvm)
  if (!onlyExisting) return candidates
  return candidates.filter((d) => {
    try {
      return fs.exists(d)
    } catch {
      return false
    }
  })
}

/** The text between the first and second marker, or null. Anything outside the markers is ignored. */
export function parseMarkedPath(stdout: string, marker: string): string | null {
  const start = stdout.indexOf(marker)
  if (start < 0) return null
  const from = start + marker.length
  const end = stdout.indexOf(marker, from)
  if (end < 0) return null
  const text = stdout.slice(from, end).trim()
  return text === '' ? null : text
}

export type ShellResult = { kind: 'ok'; stdout: string } | { kind: 'timeout' } | { kind: 'error'; message: string }
export type ShellRunner = (shell: string, args: string[], timeoutMs: number) => Promise<ShellResult>

/** Runs the shell without a terminal; kills its whole process group on timeout. Never rejects. */
export const defaultShellRunner: ShellRunner = (shell, args, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false
    const finish = (r: ShellResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    let stdout = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: process.env })
    } catch (err) {
      resolve({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      return
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      finish({ kind: 'timeout' })
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => (stdout += d))
    child.stderr?.resume()
    child.on('error', (err) => finish({ kind: 'error', message: err.message }))
    child.on('close', (code) =>
      finish(code === 0 || stdout !== '' ? { kind: 'ok', stdout } : { kind: 'error', message: `shell exited with ${code}` })
    )
  })

export interface LoginShellPathOptions {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
  shell: string
  run: ShellRunner
  fs: DirFs
  timeoutMs?: number
  marker?: string
}

export interface LoginShellPathResult {
  source: 'unchanged' | 'shell' | 'fallback'
  path: string
  reason?: string
}

function mergePaths(first: string[], second: string[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of [...first, ...second]) {
    if (p === '' || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out.join(':')
}

/**
 * The PATH an app started from Finder, the Dock or a desktop entry should use: the one the user's login shell
 * builds (as VS Code does), or the well-known install folders if that fails. Does nothing on Windows or when
 * started from a terminal (TERM is set), where PATH is already right.
 */
export async function loginShellPath(opts: LoginShellPathOptions): Promise<LoginShellPathResult> {
  const current = opts.env.PATH ?? ''
  if (opts.platform === 'win32' || opts.env.TERM) return { source: 'unchanged', path: current }
  const marker = opts.marker ?? `__MAINBUS_PATH_${randomUUID()}__`
  const cmd = `printf '%s' '${marker}'; printenv PATH; printf '%s' '${marker}'`
  const currentParts = current.split(':')
  const result = await opts.run(opts.shell, ['-ilc', cmd], opts.timeoutMs ?? 3000)
  let reason: string
  if (result.kind === 'ok') {
    const parsed = parseMarkedPath(result.stdout, marker)
    if (parsed) return { source: 'shell', path: mergePaths(parsed.split(':'), currentParts) }
    reason = 'the login shell printed no PATH'
  } else if (result.kind === 'timeout') {
    reason = 'the login shell timed out'
  } else {
    reason = result.message
  }
  return { source: 'fallback', path: mergePaths(wellKnownBinDirs(opts.home, opts.fs, opts.platform), currentParts), reason }
}

export interface ApplyDeps {
  platform?: NodeJS.Platform
  run?: ShellRunner
  fs?: DirFs
  timeoutMs?: number
}

/** Sets `env.PATH` from the login shell. Every child process copies the environment, so agents and setup commands inherit it. */
export async function applyLoginShellPath(env: NodeJS.ProcessEnv = process.env, deps: ApplyDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform
  let shellFromUser = ''
  if (platform !== 'win32' && !env.SHELL) {
    try {
      shellFromUser = userInfo().shell ?? ''
    } catch {
      /* no passwd entry */
    }
  }
  const r = await loginShellPath({
    platform,
    env,
    home: env.HOME || homedir(),
    shell: env.SHELL || shellFromUser || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh'),
    run: deps.run ?? defaultShellRunner,
    fs: deps.fs ?? defaultDirFs,
    timeoutMs: deps.timeoutMs
  })
  if (r.source === 'unchanged') return
  env.PATH = r.path
  if (r.source === 'fallback') console.warn(`Login-shell PATH unavailable (${r.reason}); using the common install folders`)
}
