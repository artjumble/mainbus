import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import type { ProcessSweeper } from '../processes/sweep'

/** How many lines of output the thread entry and the role prompt keep. */
export const SETUP_TAIL_LINES = 50
const LINE_MAX = 2000

export interface SetupCommandRequest {
  command: string
  /** The ticket's worktree. */
  cwd: string
  /** The ticket's scratch folder: the command's TEMP and TMP. */
  tempDir: string
  timeoutMs: number
  /** Aborting ends the command's process tree. */
  signal: AbortSignal
  /** The file that gets all of the command's output. */
  logPath: string
}

export interface SetupCommandResult {
  /** Null when the command was ended (timeout or abort) or could not start. */
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  /** The last SETUP_TAIL_LINES lines of output. */
  tail: string[]
}

/** Runs the workspace's setup command. Tests replace it with a fake. */
export type SetupCommandRunner = (request: SetupCommandRequest) => Promise<SetupCommandResult>

const TEMP_ENV_VARS = new Set(['TEMP', 'TMP', 'TMPDIR'])

/** Our environment with TEMP, TMP and TMPDIR (in every spelling, as Windows names are case-insensitive) set to the scratch folder. */
function setupEnv(tempDir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) if (!TEMP_ENV_VARS.has(k.toUpperCase())) env[k] = v
  env.TEMP = env.TMP = env.TMPDIR = tempDir
  return env
}

/** Keeps the last `max` lines of a stream of text, splitting on \n or \r\n. */
class Tail {
  private lines: string[] = []
  private partial = ''
  constructor(private readonly max: number) {}

  push(text: string): void {
    const parts = (this.partial + text).split(/\r?\n/)
    this.partial = parts.pop()!
    for (const line of parts) this.add(line)
  }

  result(): string[] {
    return this.partial === '' ? this.lines : [...this.lines, this.partial.slice(0, LINE_MAX)].slice(-this.max)
  }

  private add(line: string): void {
    this.lines.push(line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line)
    if (this.lines.length > this.max) this.lines.shift()
    if (this.partial.length > LINE_MAX) this.partial = this.partial.slice(-LINE_MAX)
  }
}

/**
 * The real runner: the command runs through the shell in the worktree, without a window, with the scratch folder as
 * TEMP and TMP. Its output goes to `logPath` as it comes. On timeout or abort the whole process tree is ended through
 * the sweeper (the shell is the root, so what npm and node started goes with it); without one the shell alone is killed.
 */
export function createSetupCommandRunner(sweeper?: ProcessSweeper): SetupCommandRunner {
  return (req) =>
    new Promise<SetupCommandResult>((resolve) => {
      const log = createWriteStream(req.logPath, { flags: 'w' })
      log.on('error', () => {})
      const tail = new Tail(SETUP_TAIL_LINES)
      const finish = (result: Omit<SetupCommandResult, 'tail'>): void => {
        log.end(() => resolve({ ...result, tail: tail.result() }))
      }
      const spawnedAt = Date.now()
      const child = spawn(req.command, {
        shell: true,
        cwd: req.cwd,
        env: setupEnv(req.tempDir),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let timedOut = false
      let aborted = false
      let ending: Promise<void> | null = null

      // The start time is taken right after the spawn: the sweep matches the root by pid and start time.
      const startedAt =
        child.pid !== undefined && sweeper ? sweeper.startTime(child.pid).catch(() => null) : Promise.resolve<number | null>(null)

      const end = (): Promise<void> => {
        ending ??= (async () => {
          if (child.pid !== undefined && sweeper) {
            try {
              await sweeper.sweep({ pid: child.pid, startedAt: (await startedAt) ?? spawnedAt })
              return
            } catch {
              // Fall back to the shell alone.
            }
          }
          child.kill()
        })()
        return ending
      }

      const onData = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        log.write(text)
        tail.push(text)
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)

      const onAbort = (): void => {
        aborted = true
        void end()
      }
      if (req.signal.aborted) onAbort()
      else req.signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => {
        timedOut = true
        void end()
      }, req.timeoutMs)

      child.once('error', (err) => {
        // The shell could not start.
        clearTimeout(timer)
        req.signal.removeEventListener('abort', onAbort)
        log.write(`${err.message}\n`)
        tail.push(`${err.message}\n`)
        finish({ exitCode: null, timedOut: false, aborted })
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        req.signal.removeEventListener('abort', onAbort)
        void (ending ?? Promise.resolve()).then(() => finish({ exitCode: timedOut || aborted ? null : code, timedOut, aborted }))
      })
    })
}
