import path from 'node:path'

/**
 * `MAINBUS_TEST_REPO` is the repo the folder picker answers without showing the folder dialog, so an end-to-end
 * test can drive the app. It may list several folders, separated by the platform's path delimiter: the picker
 * answers them in order, then the last again. Like the fake runtime it is honored only when MAINBUS_HOME is
 * set, and only alongside a fake runtime (`MAINBUS_RUNTIME=fake:...`), so a stray variable can never skip
 * the dialog in a normal install. Null when not honored.
 */
export function testReposFromEnv(env: NodeJS.ProcessEnv): string[] | null {
  const fake = env['MAINBUS_RUNTIME']?.startsWith('fake:') ?? false
  if (!env['MAINBUS_HOME'] || !fake) return null
  const repos = (env['MAINBUS_TEST_REPO'] ?? '').split(path.delimiter).filter((r) => r !== '')
  return repos.length > 0 ? repos : null
}

/**
 * `MAINBUS_FAKE_CLOCK` (`now`, or an ISO time) is when a fake clock starts, so an end-to-end test can move the
 * time on and have holds released at their date. Honored on the same terms as `MAINBUS_TEST_REPO`: only with
 * MAINBUS_HOME set and a fake runtime. Null when not honored.
 */
export function testClockStartFromEnv(env: NodeJS.ProcessEnv, now: Date = new Date()): Date | null {
  const value = env['MAINBUS_FAKE_CLOCK']
  const fake = env['MAINBUS_RUNTIME']?.startsWith('fake:') ?? false
  if (!env['MAINBUS_HOME'] || !fake || !value) return null
  if (value === 'now') return now
  const start = new Date(value)
  return Number.isNaN(start.getTime()) ? null : start
}
