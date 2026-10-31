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
