/**
 * `MAINBUS_TEST_REPO` is the repo the "Open a repo folder" button opens without showing the folder dialog,
 * so an end-to-end test can drive the app. Like the fake runtime it is honored only when MAINBUS_HOME is
 * set, and only alongside a fake runtime (`MAINBUS_RUNTIME=fake:...`), so a stray variable can never skip
 * the dialog in a normal install.
 */
export function testRepoFromEnv(env: NodeJS.ProcessEnv): string | null {
  const repo = env['MAINBUS_TEST_REPO']
  const fake = env['MAINBUS_RUNTIME']?.startsWith('fake:') ?? false
  return env['MAINBUS_HOME'] && fake && repo ? repo : null
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
