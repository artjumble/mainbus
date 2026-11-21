import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { EXPAND_CLOSE_MS } from '../src/renderer/src/expandOnHover'
import { addWorkspace } from './addWorkspace'

const root = path.resolve(import.meta.dirname, '..')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Mainbus E2E', '-c', 'user.email=e2e@mainbus.test', ...args], {
    cwd,
    windowsHide: true,
    stdio: 'pipe'
  })
}

function makeRepo(dir: string): string {
  fs.mkdirSync(dir)
  git(dir, 'init', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'README.md'), '# test repo\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'initial')
  return dir
}

// One app for the whole file, run in order: two workspaces, alpha-repo and bravo-repo. Each test starts with
// alpha-repo focused, nothing open, and the pointer well away from the rail.
test.describe.configure({ mode: 'serial' })

let tmp: string
let app: ElectronApplication | undefined
let page: Page

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  const repoA = makeRepo(path.join(tmp, 'alpha-repo'))
  const repoB = makeRepo(path.join(tmp, 'bravo-repo'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: {
      ...env,
      MAINBUS_HOME: path.join(tmp, 'home'),
      MAINBUS_RUNTIME: 'fake:e2e/fixtures/handoff.json',
      MAINBUS_TEST_REPO: [repoA, repoB].join(path.delimiter)
    }
  })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 960))
  await addWorkspace(page)
  const rail = page.getByRole('navigation', { name: 'Workspaces' })
  await rail.getByRole('button', { name: 'Add workspace' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Choose folder…' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test.beforeEach(async () => {
  // Close whatever the last test left open: a dialog or a menu.
  for (let i = 0; i < 3 && (await page.getByRole('dialog').or(page.getByRole('menu')).count()) > 0; i++) await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const rail = page.getByRole('navigation', { name: 'Workspaces' })
  await rail.getByRole('button', { name: /^alpha-repo/ }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'alpha-repo' })).toBeVisible()
  await page.mouse.move(700, 500)
  await expect(rail).toHaveAttribute('data-expanded', 'false')
})

test.afterAll(async () => {
  await app?.close().catch(() => {})
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A temp folder left behind is harmless.
  }
})

test('hovering the rail opens it over the board without moving the board, and a click switches workspace and lets it close', async () => {
  const rail = page.getByRole('navigation', { name: 'Workspaces' })
  const main = page.getByRole('main')
  const backlog = page.getByRole('heading', { level: 2, name: 'alpha-repo' })
  // The rail's width eases over 150 ms: wait for the final width rather than reading it once.
  await expect.poll(async () => (await rail.boundingBox())!.width).toBeLessThanOrEqual(72)
  const mainBox = await main.boundingBox()
  const backlogBox = await backlog.boundingBox()

  const entryB = rail.getByRole('button', { name: /^bravo-repo/ })
  await entryB.hover()
  await expect(rail).toHaveAttribute('data-expanded', 'true')
  await expect.poll(async () => (await rail.boundingBox())!.width).toBeGreaterThan(150)
  await expect(rail.locator('[data-rail-status]')).toHaveCount(2)
  await expect(rail).toContainText('bravo-repo')
  expect(await main.boundingBox()).toEqual(mainBox)
  expect(await backlog.boundingBox()).toEqual(backlogBox)

  await entryB.click()
  await expect(page.getByRole('heading', { level: 2, name: 'bravo-repo' })).toBeVisible()
  await page.mouse.move(700, 500)
  await expect(rail).toHaveAttribute('data-expanded', 'false')
  await expect.poll(async () => (await rail.boundingBox())!.width).toBeLessThanOrEqual(72)
})

test('Tab into the rail opens it, Enter switches workspace, and Tab out closes it', async () => {
  const rail = page.getByRole('navigation', { name: 'Workspaces' })
  // A fresh page has nothing focused, so the first Tab lands on the rail, which comes first in the page.
  await page.reload()
  await expect(page.getByRole('heading', { level: 2, name: 'alpha-repo' })).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(rail.getByRole('button', { name: /^alpha-repo/ })).toBeFocused()
  await expect(rail).toHaveAttribute('data-expanded', 'true')

  await page.keyboard.press('Tab') // Options for alpha-repo
  await page.keyboard.press('Tab') // bravo-repo
  await expect(rail.getByRole('button', { name: /^bravo-repo/ })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 2, name: 'bravo-repo' })).toBeVisible()
  await expect(rail).toHaveAttribute('data-expanded', 'true')

  for (let i = 0; i < 6 && (await rail.evaluate((nav) => nav.contains(document.activeElement))); i++) {
    await page.keyboard.press('Tab')
  }
  await expect(rail).toHaveAttribute('data-expanded', 'false')
})

test('Options → Settings works from the expanded rail, which stays open while the menu is', async () => {
  const rail = page.getByRole('navigation', { name: 'Workspaces' })
  await rail.hover()
  await page.getByRole('button', { name: 'Options for bravo-repo' }).click()
  const menu = page.getByRole('menu')
  await menu.hover()
  // A negative check against an app timer: the rail would collapse EXPAND_CLOSE_MS after the pointer left it, and
  // nothing on the page signals that it did not, so wait out the timer with a margin.
  await page.waitForTimeout(EXPAND_CLOSE_MS + 200)
  await expect(rail).toHaveAttribute('data-expanded', 'true')
  await expect(menu).toContainText('bravo-repo')
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await expect(page.getByRole('dialog', { name: 'Workspace settings' })).toBeVisible()
  await expect(rail.getByRole('button', { name: /^bravo-repo/ })).toHaveAttribute('aria-current', 'true')
})

// Last: it changes the workspaces' labels for good.
test('the widest custom labels stay inside the collapsed rail, with room for the needs-you badge', async () => {
  const rail = page.getByRole('navigation', { name: 'Workspaces' })
  // The focused workspace is alpha-repo; give each workspace one of the widest labels.
  await page.evaluate(async () => {
    const api = (window as unknown as { mainbus: { invoke(c: string, ...a: unknown[]): Promise<{ id: string }[]> } }).mainbus
    const list = await api.invoke('workspace.list')
    await api.invoke('workspace.setRailBadge', { label: 'MWW' }, list[0]!.id)
    await api.invoke('workspace.setRailBadge', { label: '🚀🚀🚀' }, list[1]!.id)
  })
  for (const [name, label] of [[/^alpha-repo/, 'MWW'], [/^bravo-repo/, '🚀🚀🚀']] as const) {
    const button = rail.getByRole('button', { name })
    const tile = button.locator(`[data-initials="${label}"]`)
    await expect(tile).toBeVisible()
    // Polled: the rail's width may still be easing to its collapsed size.
    await expect(async () => {
      const [t, b, n] = await Promise.all([tile.boundingBox(), button.boundingBox(), rail.boundingBox()])
      expect(t!.x + t!.width).toBeLessThanOrEqual(b!.x + b!.width)
      // The corner indicator (the needs-you badge, or the working or idle circle) overhangs the tile's corner by up to 6 px.
      expect(t!.x + t!.width + 6).toBeLessThanOrEqual(n!.x + n!.width)
      const corner = await button.locator('[data-needs-you],[data-activity]').boundingBox()
      expect(corner!.x + corner!.width).toBeGreaterThan(t!.x + t!.width - 8)
      expect(corner!.x + corner!.width).toBeLessThanOrEqual(t!.x + t!.width + 6)
      expect(corner!.y).toBeLessThan(t!.y + 8)
      expect(corner!.x + corner!.width).toBeLessThanOrEqual(n!.x + n!.width)
    }).toPass()
  }
})
