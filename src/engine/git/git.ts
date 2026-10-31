import { execFile } from 'node:child_process'

export type GitRunner = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/**
 * Runs git without a shell. Success is the exit code alone: git writes normal
 * progress and CRLF warnings to stderr. Rejects only when git can't be started.
 */
export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.longpaths=true', ...args],
      { cwd, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr })
        } else if (typeof error.code === 'number') {
          resolve({ code: error.code, stdout, stderr })
        } else {
          reject(error)
        }
      }
    )
  })
