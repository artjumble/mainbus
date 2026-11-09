import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

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

/** Two workspaces, alpha-repo and bravo-repo, with alpha-repo focused and the pointer well away from the rail. */
async function withRail(body: (page: Page) => Promise<void>): Promise<void> {
  let tmp: string | null = null
  let app: ElectronApplication | undefined
  try {
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
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 960))
    await page.getByRole('button', { name: 'Add workspace' }).click()
    const rail = page.getByRole('navigation', { name: 'Workspaces' })
    await rail.getByRole('button', { name: 'Add workspace' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Choose folder…' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await rail.getByRole('button', { name: /^alpha-repo/ }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'alpha-repo' })).toBeVisible()
    await page.mouse.move(700, 500)
    await expect(rail).toHaveAttribute('data-expanded', 'false')
    await body(page)
  } finally {
    await app?.close().catch(() => {})
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // A temp folder left behind is harmless.
      }
    }
  }
}

test('hovering the rail opens it over the board without moving the board, and a click switches workspace and lets it close', async () => {
  await withRail(async (page) => {
    const rail = page.getByRole('navigation', { name: 'Workspaces' })
    const main = page.getByRole('main')
    const backlog = page.getByRole('heading', { level: 2, name: 'alpha-repo' })
    expect((await rail.boundingBox())!.width).toBeLessThanOrEqual(72)
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
})

test('Tab into the rail opens it, Enter switches workspace, and Tab out closes it', async () => {
  await withRail(async (page) => {
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
})

test('Options → Settings works from the expanded rail, which stays open while the menu is', async () => {
  await withRail(async (page) => {
    const rail = page.getByRole('navigation', { name: 'Workspaces' })
    await rail.hover()
    await page.getByRole('button', { name: 'Options for bravo-repo' }).click()
    const menu = page.getByRole('menu')
    await menu.hover()
    await page.waitForTimeout(500)
    await expect(rail).toHaveAttribute('data-expanded', 'true')
    await expect(menu).toContainText('bravo-repo')
    await page.getByRole('menuitem', { name: 'Settings' }).click()
    await expect(page.getByRole('dialog', { name: 'Workspace settings' })).toBeVisible()
    await expect(rail.getByRole('button', { name: /^bravo-repo/ })).toHaveAttribute('aria-current', 'true')
  })
})
