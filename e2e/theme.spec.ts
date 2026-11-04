/// <reference lib="dom" />
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { GROUND } from '../src/shared/domain'
import { makeRepo } from './artboardHelpers'

const root = path.resolve(import.meta.dirname, '..')

async function launch(home: string, repo: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/artboard-detail-by-role.json', MAINBUS_TEST_REPO: repo }
  })
  return { app, page: await app.firstWindow() }
}

/** What the main process has set: the native theme source (frame and menus) and the window's own background. */
function windowTheme(app: ElectronApplication): Promise<{ source: string; background: string }> {
  return app.evaluate(({ BrowserWindow, nativeTheme }) => ({
    source: nativeTheme.themeSource,
    background: BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toUpperCase()
  }))
}

const pageScheme = (page: Page): Promise<string | null> => page.locator('html').getAttribute('data-mantine-color-scheme')
const pageGround = (page: Page): Promise<string> => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
const rgb = (hex: string): string => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Options for web-app' }).click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await expect(page.getByRole('radiogroup', { name: 'Theme', exact: true })).toBeVisible()
}

test('the Theme setting switches to Dark and back without a restart, and a dark app opens dark', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-theme-'))
  let app: ElectronApplication | undefined
  try {
    const home = path.join(tmp, 'home')
    const repo = makeRepo(tmp, 'web-app')
    let page: Page
    ;({ app, page } = await launch(home, repo))
    await page.getByRole('button', { name: 'Add workspace' }).click()
    await page.getByRole('navigation', { name: 'Workspaces' }).waitFor()

    // Light until the user picks: today's look, frame and window.
    expect(await pageScheme(page)).toBe('light')
    expect(await pageGround(page)).toBe(rgb(GROUND.light))
    expect(await windowTheme(app)).toEqual({ source: 'light', background: GROUND.light.toUpperCase() })

    await openSettings(page)
    const theme = page.getByRole('radiogroup', { name: 'Theme', exact: true })
    await expect(theme.getByRole('radio', { name: 'Light', exact: true })).toBeChecked()

    // Dark, at once: the page, the frame and the window's background.
    await theme.getByRole('radio', { name: 'Dark', exact: true }).check()
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark')
    await expect.poll(() => pageGround(page)).toBe(rgb(GROUND.dark))
    await expect.poll(() => windowTheme(app!)).toEqual({ source: 'dark', background: GROUND.dark.toUpperCase() })
    // The settings window is still open, and still says Dark.
    await expect(theme.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked()

    // And back to Light.
    await theme.getByRole('radio', { name: 'Light', exact: true }).check()
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light')
    await expect.poll(() => pageGround(page)).toBe(rgb(GROUND.light))
    await expect.poll(() => windowTheme(app!)).toEqual({ source: 'light', background: GROUND.light.toUpperCase() })

    // Match Windows hands the frame to Windows; the page takes whatever Windows says. (Playwright pretends the page
    // prefers light unless told otherwise; with that off, the page sees what Electron reports from Windows.)
    await page.emulateMedia({ colorScheme: null })
    await theme.getByRole('radio', { name: 'Match Windows' }).check()
    await expect.poll(async () => (await windowTheme(app!)).source).toBe('system')
    const windowsDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', windowsDark ? 'dark' : 'light')
    expect((await windowTheme(app)).background).toBe((windowsDark ? GROUND.dark : GROUND.light).toUpperCase())
    // Windows changing while the app runs, as the page sees it: the page follows.
    await page.emulateMedia({ colorScheme: windowsDark ? 'light' : 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', windowsDark ? 'light' : 'dark')
    await page.emulateMedia({ colorScheme: windowsDark ? 'dark' : 'light' })
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', windowsDark ? 'dark' : 'light')
    await page.emulateMedia({ colorScheme: null })

    // Dark is remembered: the next launch paints the window dark before the page loads, and the page starts dark.
    await theme.getByRole('radio', { name: 'Dark', exact: true }).check()
    await expect.poll(async () => (await windowTheme(app!)).source).toBe('dark')
    await app.close()
    app = undefined
    ;({ app, page } = await launch(home, repo))
    expect(await windowTheme(app)).toEqual({ source: 'dark', background: GROUND.dark.toUpperCase() })
    await expect(page.getByRole('navigation', { name: 'Workspaces' })).toBeVisible()
    expect(await pageScheme(page)).toBe('dark')
    expect(await pageGround(page)).toBe(rgb(GROUND.dark))
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})

test('Night Owl applies without a restart, stays after a relaunch, and Match Windows can use it for dark', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-theme-'))
  let app: ElectronApplication | undefined
  try {
    const home = path.join(tmp, 'home')
    const repo = makeRepo(tmp, 'web-app')
    let page: Page
    ;({ app, page } = await launch(home, repo))
    await page.getByRole('button', { name: 'Add workspace' }).click()
    await page.getByRole('navigation', { name: 'Workspaces' }).waitFor()

    await openSettings(page)
    const theme = page.getByRole('radiogroup', { name: 'Theme', exact: true })
    // Every theme, by name, and Match Windows.
    for (const name of ['Light', 'Dark', 'Night Owl', 'Light Owl', 'Match Windows']) {
      await expect(theme.getByRole('radio', { name, exact: true })).toBeVisible()
    }

    // Night Owl, at once: the page in its ground and dark, the frame dark, the window painted in its ground.
    await theme.getByRole('radio', { name: 'Night Owl', exact: true }).check()
    await expect(page.locator('html')).toHaveAttribute('data-mainbus-theme', 'night-owl')
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark')
    await expect.poll(() => pageGround(page)).toBe(rgb(GROUND['night-owl']))
    await expect.poll(() => windowTheme(app!)).toEqual({ source: 'dark', background: GROUND['night-owl'].toUpperCase() })

    // Light Owl, the same way.
    await theme.getByRole('radio', { name: 'Light Owl', exact: true }).check()
    await expect(page.locator('html')).toHaveAttribute('data-mainbus-theme', 'light-owl')
    await expect.poll(() => pageGround(page)).toBe(rgb(GROUND['light-owl']))
    await expect.poll(() => windowTheme(app!)).toEqual({ source: 'light', background: GROUND['light-owl'].toUpperCase() })

    // Match Windows with Night Owl for dark: the page follows Windows between Light and Night Owl.
    await theme.getByRole('radio', { name: 'Match Windows' }).check()
    await page.getByRole('radiogroup', { name: 'Dark theme' }).getByRole('radio', { name: 'Night Owl', exact: true }).check()
    await expect(page.getByRole('radiogroup', { name: 'Light theme' }).getByRole('radio', { name: 'Light', exact: true })).toBeChecked()
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-mainbus-theme', 'night-owl')
    await expect.poll(() => pageGround(page)).toBe(rgb(GROUND['night-owl']))
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('html')).toHaveAttribute('data-mainbus-theme', 'light')
    await expect.poll(() => pageGround(page)).toBe(rgb(GROUND.light))
    await page.emulateMedia({ colorScheme: null })
    await expect.poll(async () => (await windowTheme(app!)).source).toBe('system')

    // Night Owl is remembered: the next launch paints the window in its ground before the page loads.
    await theme.getByRole('radio', { name: 'Night Owl', exact: true }).check()
    await expect.poll(async () => (await windowTheme(app!)).source).toBe('dark')
    await app.close()
    app = undefined
    ;({ app, page } = await launch(home, repo))
    expect(await windowTheme(app)).toEqual({ source: 'dark', background: GROUND['night-owl'].toUpperCase() })
    await expect(page.getByRole('navigation', { name: 'Workspaces' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-mainbus-theme', 'night-owl')
    expect(await pageGround(page)).toBe(rgb(GROUND['night-owl']))
    // And so are the Match Windows picks.
    await openSettings(page)
    await expect(page.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name: 'Night Owl', exact: true })).toBeChecked()
    await page.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name: 'Match Windows' }).check()
    await expect(page.getByRole('radiogroup', { name: 'Dark theme' }).getByRole('radio', { name: 'Night Owl', exact: true })).toBeChecked()
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})
