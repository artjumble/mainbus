import { execFileSync } from 'node:child_process'
import type { ElectronApplication } from '@playwright/test'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Ends the app's whole process tree at once, with no orderly shutdown. Only ever the process this test started (the PID
 * Playwright recorded when it launched the app) and its children.
 *
 * On Windows `taskkill /T /F` can fail while the tree is already going away: exit code 128 ("not found") when the
 * process has just exited, and "access denied" (exit 1) while a child is exiting. The first counts as success, the
 * second is retried briefly; afterwards we wait for the app's process to be gone before returning.
 */
export async function killApp(app: ElectronApplication): Promise<void> {
  const child = app.process()
  const pid = child.pid
  const gone = (): boolean => child.exitCode !== null || child.signalCode !== null
  const exited = new Promise<void>((resolve) => {
    if (gone()) resolve()
    else child.once('exit', () => resolve())
  })
  if (pid === undefined || gone()) return
  if (process.platform === 'win32') {
    for (let attempt = 0; ; attempt++) {
      try {
        execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'pipe' })
        break
      } catch (error) {
        // Already gone (taskkill's "not found" is 128): that is what we wanted.
        if (gone() || (error as { status?: number }).status === 128) break
        if (attempt >= 4) throw error
        await sleep(200 * (attempt + 1))
      }
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  await Promise.race([exited, sleep(15_000).then(() => { throw new Error(`App process ${pid} did not exit after being killed`) })])
}
