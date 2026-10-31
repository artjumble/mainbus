import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { win32 } from 'node:path'
import type { ClaudeSetup } from '../../shared/domain'

export type ExecFn = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

/** `execFile` with no shell and no console window. Resolves with the exit code instead of rejecting on it. */
export const execFileNode: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, encoding: 'utf8', timeout: 30_000 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr })
      // A failure to start the program has a string `code` such as ENOENT; a non-zero exit has a number.
      const code = (err as NodeJS.ErrnoException).code
      if (typeof code === 'number') return resolve({ code, stdout, stderr })
      reject(err)
    })
  })

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

function firstLine(text: string): string {
  return lines(text)[0] ?? ''
}

async function tryExec(exec: ExecFn, file: string, args: string[]) {
  try {
    return await exec(file, args)
  } catch (err) {
    return { code: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
}

/** What the native-installer fallback looks at; injectable so tests don't depend on the machine. */
export interface FallbackFs {
  exists: (path: string) => boolean
  /** The user's home folder (%USERPROFILE%). */
  home: string
}

const defaultFallbackFs = (): FallbackFs => ({ exists: existsSync, home: process.env.USERPROFILE || homedir() })

/**
 * Finds the user's official `claude` binary and checks that it is logged in.
 * On Windows only an `.exe` can be spawned without a shell, so `.cmd` shims are skipped.
 * If PATH has no `.exe`, the native installer's `%USERPROFILE%\.local\bin\claude.exe` is tried: an app started
 * from the Start menu can have a narrower PATH than a terminal.
 */
export async function resolveClaude(
  exec: ExecFn,
  platform: NodeJS.Platform = process.platform,
  fallbackFs: FallbackFs = defaultFallbackFs()
): Promise<ClaudeSetup> {
  const windows = platform === 'win32'
  const found = windows ? await tryExec(exec, 'where.exe', ['claude']) : await tryExec(exec, 'which', ['claude'])
  const candidates = found.code === 0 ? lines(found.stdout) : []
  let claudePath = windows ? candidates.find((l) => /\.exe$/i.test(l)) : candidates[0]
  if (!claudePath && windows) {
    const native = win32.join(fallbackFs.home, '.local', 'bin', 'claude.exe')
    if (fallbackFs.exists(native)) claudePath = native
  }
  if (!claudePath) {
    const why = found.code === 0 ? 'only non-.exe launchers were found' : firstLine(found.stderr) || 'not on PATH'
    return { ok: false, reason: 'not_found', detail: `Could not find claude: ${why}` }
  }

  const versionRun = await tryExec(exec, claudePath, ['--version'])
  const version = versionRun.code === 0 ? /\d+\.\d+\.\d+\S*/.exec(versionRun.stdout)?.[0] : undefined
  if (!version) {
    return { ok: false, reason: 'not_found', detail: `${claudePath} did not report a version` }
  }

  const auth = await tryExec(exec, claudePath, ['auth', 'status'])
  if (auth.code !== 0) {
    const why = firstLine(auth.stderr) || firstLine(auth.stdout) || 'claude auth status failed'
    return { ok: false, reason: 'not_logged_in', detail: why }
  }
  return { ok: true, path: claudePath, version }
}
