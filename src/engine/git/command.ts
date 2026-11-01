import { execFile } from 'node:child_process'

export interface CommandOptions {
  cwd: string
  /** Added to the app's own environment. */
  env?: Record<string, string>
  timeoutMs: number
}

export interface CommandOutput {
  code: number
  stdout: string
  stderr: string
  /** The command was killed because it ran past `timeoutMs`. */
  timedOut: boolean
}

/** Runs a program without a shell. Rejects only when it can't be started (not installed). */
export type CommandRunner = (file: string, args: string[], opts: CommandOptions) => Promise<CommandOutput>

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

export const runCommand: CommandRunner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        timeout: opts.timeoutMs,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES
      },
      (error, stdout, stderr) => {
        if (error === null) return resolve({ code: 0, stdout, stderr, timedOut: false })
        if (error.killed) return resolve({ code: -1, stdout, stderr, timedOut: true })
        // A failure to start the program has a string `code` such as ENOENT; a non-zero exit has a number.
        if (typeof error.code === 'number') return resolve({ code: error.code, stdout, stderr, timedOut: false })
        reject(error)
      }
    )
  })
