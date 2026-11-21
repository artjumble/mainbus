import { _electron as electron } from '@playwright/test'

/**
 * Electron launch reliability under parallel load.
 *
 * Symptom: with several workers, `electron.launch()` sometimes rejects with "Process failed to launch!" (Electron
 * exited before Playwright saw its debugger endpoint), across unrelated specs; a rerun passes. Seen in #173 (right
 * after a build) and #176 (7 of 20 at 4 workers).
 *
 * Cause: not isolated. It was not reproducible in #182 (88 launches at 4 and 12 workers, none failed), and the app's
 * single-instance lock is per MAINBUS_HOME (userData lives in it) and every test has its own home, so the tests can't
 * collide there. It is a transient process start failure while the machine is saturated (a cold, freshly built
 * `out/` being scanned by antivirus, and many Electron starts at once). Nothing in the tests or the app is shared that
 * a unique name could fix.
 *
 * Backstop: `electron.launch` is wrapped once, for every spec (playwright.config.ts installs it in the main process
 * and in each worker, which load the config). It retries ONLY a rejected launch whose message says "Process failed to
 * launch", once, and logs the error with Electron's output (Playwright puts it in the message) so the cause can be
 * found if it ever fires. The test body is never retried: a launch that succeeded is never repeated.
 * `MAINBUS_E2E_LAUNCH_RETRIES` counts how many times it fired when set to a file path (one line per retry).
 */
const MARK = Symbol.for('mainbus.launchRetry')
const FAILED = /Process failed to launch/i

export function installLaunchRetry(): void {
  const target = electron as unknown as Record<symbol, unknown> & { launch: typeof electron.launch }
  if (target[MARK]) return
  target[MARK] = true
  const original = target.launch.bind(electron)
  target.launch = async (options) => {
    try {
      return await original(options)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!FAILED.test(message)) throw error
      console.warn(`[e2e] electron.launch failed to start; retrying once. ${message}`)
      const file = process.env['MAINBUS_E2E_LAUNCH_RETRIES']
      if (file) (await import('node:fs')).appendFileSync(file, `${new Date().toISOString()} pid ${process.pid}\n`)
      await new Promise((resolve) => setTimeout(resolve, 1000))
      return await original(options)
    }
  }
}
