/// <reference lib="dom" />
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { addWorkspace } from './addWorkspace'
import { GROUND } from '../src/shared/domain'
import { makeRepo } from './artboardHelpers'

const root = path.resolve(import.meta.dirname, '..')

/** `repo` may list several folders, joined with the path delimiter: the folder picker answers them in order. */
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

/** Opens the Mainbus settings from the rail's button; the Theme is under Appearance. */
async function openSettings(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Mainbus settings' }).click()
  const appearance = page.getByRole('dialog', { name: 'Mainbus settings' }).getByRole('region', { name: 'Appearance' })
  await expect(appearance.getByRole('combobox', { name: 'Theme', exact: true })).toBeVisible()
}

/** Opens a theme dropdown and picks a theme by name. */
async function pickTheme(scope: Page | Locator, label: string, name: string): Promise<void> {
  await scope.getByRole('combobox', { name: label, exact: true }).click()
  await ('goto' in scope ? scope : scope.page()).getByRole('option', { name: new RegExp(`^${name} ?,`) }).click()
}

test('the Theme setting switches between Light, Dark, Night Owl and Light Owl without a restart, Match Windows can use Night Owl for dark, and a dark app opens in its theme', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-theme-'))
  let app: ElectronApplication | undefined
  try {
    const home = path.join(tmp, 'home')
    const repo = makeRepo(tmp, 'web-app')
    let page: Page
    ;({ app, page } = await launch(home, repo))
    await addWorkspace(page)

    // Light until the user picks: today's look, frame and window.
    expect(await pageScheme(page)).toBe('light')
    expect(await pageGround(page)).toBe(rgb(GROUND.light))
    expect(await windowTheme(app)).toEqual({ source: 'light', background: GROUND.light.toUpperCase() })

    await openSettings(page)
    const mode = page.getByRole('radiogroup', { name: 'Theme', exact: true })
    const theme = page.getByRole('combobox', { name: 'Theme', exact: true })
    await expect(theme).toHaveValue('Light')
    // Every theme, by name.
    await theme.click()
    for (const name of ['Light', 'Dark', 'Night Owl', 'Light Owl']) {
      await expect(page.getByRole('option', { name: new RegExp(`^${name} ?,`) })).toBeVisible()
    }
    await page.keyboard.press('Escape')

    // Dark, at once: the page, the frame and the window's background.
    await pickTheme(page, 'Theme', 'Dark')
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark')
    await expect.poll(() => pageGround(page)).toBe(rgb(GROUND.dark))
    await expect.poll(() => windowTheme(app!)).toEqual({ source: 'dark', background: GROUND.dark.toUpperCase() })
    // The settings window is still open, and still says Dark.
    await expect(theme).toHaveValue('Dark')

    // Night Owl, at once: the page in its ground and dark, the frame dark, the window painted in its ground.
    await pickTheme(page, 'Theme', 'Night Owl')
    await expect(page.locator('html')).toHaveAttribute('data-mainbus-theme', 'night-owl')
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark')
    await expect.poll(() => pageGround(page)).toBe(rgb(GROUND['night-owl']))
    await expect.poll(() => windowTheme(app!)).toEqual({ source: 'dark', background: GROUND['night-owl'].toUpperCase() })

    // Light Owl, the same way.
    await pickTheme(page, 'Theme', 'Light Owl')
    await expect(page.locator('html')).toHaveAttribute('data-mainbus-theme', 'light-owl')
    await expect.poll(() => pageGround(page)).toBe(rgb(GROUND['light-owl']))
    await expect.poll(() => windowTheme(app!)).toEqual({ source: 'light', background: GROUND['light-owl'].toUpperCase() })

    // And back to Light.
    await pickTheme(page, 'Theme', 'Light')
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light')
    await expect.poll(() => pageGround(page)).toBe(rgb(GROUND.light))
    await expect.poll(() => windowTheme(app!)).toEqual({ source: 'light', background: GROUND.light.toUpperCase() })

    // Match Windows hands the frame to Windows; the page takes whatever Windows says. (Playwright pretends the page
    // prefers light unless told otherwise; with that off, the page sees what Electron reports from Windows.)
    await page.emulateMedia({ colorScheme: null })
    await mode.getByText('Match Windows', { exact: true }).click()
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

    // Match Windows with Night Owl for dark: the page follows Windows between Light and Night Owl.
    await pickTheme(page, 'When Windows is dark', 'Night Owl')
    await expect(page.getByRole('combobox', { name: 'When Windows is light', exact: true })).toHaveValue('Light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-mainbus-theme', 'night-owl')
    await expect.poll(() => pageGround(page)).toBe(rgb(GROUND['night-owl']))
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('html')).toHaveAttribute('data-mainbus-theme', 'light')
    await expect.poll(() => pageGround(page)).toBe(rgb(GROUND.light))
    await page.emulateMedia({ colorScheme: null })
    await expect.poll(async () => (await windowTheme(app!)).source).toBe('system')

    // Night Owl is remembered: the next launch paints the window in its ground before the page loads, and the page starts dark.
    await mode.getByText('Single theme', { exact: true }).click()
    await pickTheme(page, 'Theme', 'Night Owl')
    await expect.poll(async () => (await windowTheme(app!)).source).toBe('dark')
    await app.close()
    app = undefined
    ;({ app, page } = await launch(home, repo))
    expect(await windowTheme(app)).toEqual({ source: 'dark', background: GROUND['night-owl'].toUpperCase() })
    await expect(page.getByRole('navigation', { name: 'Workspaces' })).toBeVisible()
    expect(await pageScheme(page)).toBe('dark')
    await expect(page.locator('html')).toHaveAttribute('data-mainbus-theme', 'night-owl')
    expect(await pageGround(page)).toBe(rgb(GROUND['night-owl']))
    // And so are the Match Windows picks.
    await openSettings(page)
    await expect(page.getByRole('combobox', { name: 'Theme', exact: true })).toHaveValue('Night Owl')
    await page.getByRole('radiogroup', { name: 'Theme', exact: true }).getByText('Match Windows', { exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'When Windows is dark', exact: true })).toHaveValue('Night Owl')
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})

test('the Theme is in the Mainbus settings before any workspace, and is the same whichever workspace is focused', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-theme-'))
  let app: ElectronApplication | undefined
  try {
    const home = path.join(tmp, 'home')
    const repoA = makeRepo(tmp, 'alpha-repo')
    const repoB = makeRepo(tmp, 'bravo-repo')
    let page: Page
    // The folder picker answers alpha-repo first, then bravo-repo.
    ;({ app, page } = await launch(home, [repoA, repoB].join(path.delimiter)))

    // The first launch: no workspace yet, and the rail's button is there all the same.
    await expect(page.getByRole('heading', { name: 'Welcome to Mainbus' })).toBeVisible()
    const button = page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Mainbus settings' })
    await button.click()
    const drawer = page.getByRole('dialog', { name: 'Mainbus settings' })
    await pickTheme(drawer, 'Theme', 'Night Owl')
    await expect(page.locator('html')).toHaveAttribute('data-mainbus-theme', 'night-owl')
    await expect.poll(() => pageGround(page)).toBe(rgb(GROUND['night-owl']))
    // Esc closes it and gives focus back to the button.
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(button).toBeFocused()

    // Two workspaces.
    await page.getByRole('main').getByRole('button', { name: 'Add workspace' }).click()
    const rail = page.getByRole('navigation', { name: 'Workspaces' })
    await expect(rail.getByRole('button', { name: /^alpha-repo/ })).toHaveAttribute('aria-current', 'true')
    await rail.getByRole('button', { name: 'Add workspace' }).click()
    await page.getByRole('dialog', { name: 'Add workspace' }).getByRole('button', { name: 'Choose folder…' }).click()
    await expect(rail.getByRole('button', { name: /^bravo-repo/ })).toHaveAttribute('aria-current', 'true')
    await expect(page.locator('html')).toHaveAttribute('data-mainbus-theme', 'night-owl')

    // Picked with bravo-repo focused, it holds for alpha-repo too.
    await page.keyboard.press('ControlOrMeta+,')
    await pickTheme(drawer, 'Theme', 'Light Owl')
    await expect(page.locator('html')).toHaveAttribute('data-mainbus-theme', 'light-owl')
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await rail.getByRole('button', { name: /^alpha-repo/ }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'alpha-repo' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-mainbus-theme', 'light-owl')
    expect(await pageGround(page)).toBe(rgb(GROUND['light-owl']))
    await page.keyboard.press('ControlOrMeta+,')
    await expect(drawer.getByRole('combobox', { name: 'Theme', exact: true })).toHaveValue('Light Owl')
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()

    // The Workspace settings no longer show the Theme; General keeps its two settings.
    await page.getByRole('button', { name: 'Workspace settings' }).click()
    const workspaceSettings = page.getByRole('dialog', { name: 'Workspace settings' })
    const general = workspaceSettings.getByRole('region', { name: 'General' })
    await expect(general.getByRole('textbox', { name: 'Agents running at once' })).toBeVisible()
    await expect(general.getByRole('radiogroup', { name: 'When I close the window' })).toBeVisible()
    await expect(workspaceSettings.getByRole('combobox', { name: 'Theme', exact: true })).toHaveCount(0)
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})
