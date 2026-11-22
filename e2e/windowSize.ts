import type { Page } from '@playwright/test'

/**
 * The content size of the small-window runs: the macOS CI runner's display is 1024×768 with a 1024×677 work area, less the
 * title bar. Other runs use the app's own test size (1280×800 content, on every OS).
 */
export const SMALL_WINDOW = '1024x649'

/** The window sizes a spec runs at: the standard one (null) and the small one. */
export const WINDOW_SIZES: Array<string | null> = [null, SMALL_WINDOW]

/** The part of a test's title that names a small window. */
export function sizeSuffix(size: string | null): string {
  return size ? ` (${size} window)` : ''
}

/** The env entry that sets the window's content size for a launch. */
export function sizeEnv(size: string | null): Record<string, string> {
  return size ? { MAINBUS_TEST_WINDOW_SIZE: size } : {}
}

/** Closes the side pane that {@link openDetailsIfNarrow} opened, so it doesn't cover the conversation. */
export async function closeDetailsIfNarrow(page: Page): Promise<void> {
  const details = page.getByRole('button', { name: 'Details', exact: true })
  if ((await details.count()) > 0 && (await details.getAttribute('aria-expanded')) === 'true') await details.click()
}

/** In a narrow ticket view the side pane (your words, spec, activity) is behind a Details button: opens it. */
export async function openDetailsIfNarrow(page: Page): Promise<void> {
  const details = page.getByRole('button', { name: 'Details', exact: true })
  if ((await details.count()) > 0 && (await details.getAttribute('aria-expanded')) === 'false') await details.click()
}
