/// <reference lib="dom" />
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { INVOKE_CHANNEL, OPEN_FOLDER_CHANNEL } from '../src/shared/api'
import { makeRepo, THEME_IDS, useTheme } from './artboardHelpers'

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

/** How far the dialog's content runs past what it shows: above 0, the dialog has a scrollbar. */
function overflowOf(dialog: Locator): Promise<number> {
  return dialog.evaluate((el) => el.scrollHeight - el.clientHeight)
}

/** The button's hit area (its ::after), and how far its label's box reaches below the button. */
function boxesOf(button: Locator): Promise<{ hitWidth: number; hitHeight: number; labelBelow: number }> {
  return button.evaluate((el) => {
    const after = getComputedStyle(el, '::after')
    const inner = el.querySelector('.mantine-Button-inner')!
    return {
      hitWidth: parseFloat(after.width),
      hitHeight: parseFloat(after.height),
      labelBelow: inner.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom
    }
  })
}

/** Checks the dialog has no scrollbar with the button at rest, hovered and focused. */
async function expectNoScrollAtRest(page: Page, dialog: Locator, button: Locator, what: string): Promise<void> {
  expect(await overflowOf(dialog), `${what}: at rest`).toBeLessThanOrEqual(0)
  await button.hover()
  expect(await overflowOf(dialog), `${what}: hovered`).toBeLessThanOrEqual(0)
  await button.focus()
  expect(await overflowOf(dialog), `${what}: focused`).toBeLessThanOrEqual(0)
  await page.mouse.move(0, 0)
}

/** Has `channel` answer `hang` commands never (a picker left open, a slow removal), and the rest as before. */
async function hang(app: ElectronApplication, channel: string, hang: string | null): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, { channel, hang }) => {
      // Electron keeps the handlers in a private map; the test reaches into it to keep the one it replaces.
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers
      const original = handlers.get(channel)!
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (event, command: unknown, ...rest: unknown[]) =>
        hang === null || command === hang ? new Promise(() => {}) : original(event, command, ...rest)
      )
    },
    { channel, hang }
  )
}

test('a loading button adds no scrollbar to the Add workspace and Remove workspace dialogs, in every theme', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-loading-'))
  let app: ElectronApplication | undefined
  try {
    const home = path.join(tmp, 'home')
    const repo = makeRepo(tmp, 'web-app')
    let page: Page
    ;({ app, page } = await launch(home, repo))
    await page.getByRole('button', { name: 'Add workspace' }).click()
    const rail = page.getByRole('navigation', { name: 'Workspaces' })
    await rail.waitFor()

    // Remove workspace, at rest, in every theme; then its removal never finishes, so Remove keeps spinning.
    await rail.hover()
    await page.getByRole('button', { name: 'Options for web-app' }).click()
    await page.getByRole('menuitem', { name: 'Remove…' }).click()
    const removeDialog = page.getByRole('dialog', { name: 'Remove workspace' })
    const remove = removeDialog.getByRole('button', { name: 'Remove', exact: true })
    for (const theme of THEME_IDS) {
      await useTheme(page, theme)
      await expectNoScrollAtRest(page, removeDialog, remove, `Remove workspace, ${theme}`)
    }
    await hang(app, INVOKE_CHANNEL, 'workspace.remove')
    await remove.click()
    await expect(remove).toHaveAttribute('data-loading', 'true')
    for (const theme of THEME_IDS) {
      await useTheme(page, theme)
      // Past Mantine's 150 ms slide of the label, which is when the scrollbar came.
      await page.waitForTimeout(300)
      expect(await overflowOf(removeDialog), `Remove workspace loading, ${theme}`).toBeLessThanOrEqual(0)
    }
    await page.keyboard.press('Escape')
    await expect(removeDialog).toHaveCount(0)

    // Add workspace, at rest, in every theme; then the folder picker stays open, so "Choose folder…" keeps spinning.
    await rail.getByRole('button', { name: 'Add workspace' }).click()
    const addDialog = page.getByRole('dialog', { name: 'Add workspace' })
    const choose = addDialog.getByRole('button', { name: 'Choose folder…' })
    for (const theme of THEME_IDS) {
      await useTheme(page, theme)
      await expectNoScrollAtRest(page, addDialog, choose, `Add workspace, ${theme}`)
    }
    await hang(app, OPEN_FOLDER_CHANNEL, null)
    await choose.click()
    await expect(choose).toHaveAttribute('data-loading', 'true')
    for (const theme of THEME_IDS) {
      await useTheme(page, theme)
      await page.waitForTimeout(300)
      expect(await overflowOf(addDialog), `Add workspace loading, ${theme}`).toBeLessThanOrEqual(0)
      // The spinning button keeps its 44 px hit area, and its faded label stays in the button.
      const boxes = await boxesOf(choose)
      expect(boxes.hitWidth, theme).toBeGreaterThanOrEqual(44)
      expect(boxes.hitHeight, theme).toBeGreaterThanOrEqual(44)
      expect(boxes.labelBelow, theme).toBeLessThanOrEqual(0)
    }
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})
