import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '..')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Mainbus E2E', '-c', 'user.email=e2e@mainbus.test', ...args], {
    cwd,
    windowsHide: true,
    stdio: 'pipe',
    encoding: 'utf8'
  })
}

/** A temp folder with a throwaway repo and a Mainbus home of its own. */
function makeRepo(): { tmp: string; home: string; repo: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  const repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')
  return { tmp, home: path.join(tmp, 'home'), repo }
}

async function launch(home: string, repo: string, open = true): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/orchestrator-drafting.json', MAINBUS_TEST_REPO: repo }
  })
  const page = await app.firstWindow()
  if (open) await page.getByRole('button', { name: 'Add workspace' }).click()
  return { app, page }
}

const asideWidth = async (page: Page): Promise<number> =>
  (await page.getByRole('complementary', { name: 'Orchestrator' }).boundingBox())!.width

test('dragging the panel edge resizes it within the limits; the width survives a relaunch and a small window', async () => {
  const { tmp, home, repo } = makeRepo()
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, repo))
    const separator = page.getByRole('separator', { name: 'Resize orchestrator panel' })
    await expect(separator).toHaveAttribute('aria-valuenow', '340')
    expect(await asideWidth(page)).toBeCloseTo(340, 0)

    const drag = async (dx: number): Promise<void> => {
      const box = (await separator.boundingBox())!
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + dx, y, { steps: 10 })
      await page.mouse.up()
    }

    // The window is about 1280 wide: the panel may grow to about 640.
    await drag(-200)
    await expect(separator).toHaveAttribute('aria-valuenow', '540')
    expect(await asideWidth(page)).toBeCloseTo(540, 0)
    await drag(-400)
    const max = await separator.getAttribute('aria-valuemax')
    expect(Number(max)).toBeGreaterThan(540)
    expect(Number(max)).toBeLessThanOrEqual(640)
    await expect(separator).toHaveAttribute('aria-valuenow', max!)
    await drag(300)
    await expect(separator).toHaveAttribute('aria-valuenow', String(Number(max) - 300))
    await drag(Number(max) - 300 - 540)
    await expect(separator).toHaveAttribute('aria-valuenow', '540')

    await app.close()
    app = undefined
    ;({ app, page } = await launch(home, repo, false))
    await expect(page.getByRole('separator', { name: 'Resize orchestrator panel' })).toHaveAttribute('aria-valuenow', '540')
    expect(await asideWidth(page)).toBeCloseTo(540, 0)

    // A small window clamps the width without losing it.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(900, 700))
    await expect(page.getByRole('separator', { name: 'Resize orchestrator panel' })).toHaveAttribute('aria-valuenow', '450')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800))
    await expect(page.getByRole('separator', { name: 'Resize orchestrator panel' })).toHaveAttribute('aria-valuenow', '540')
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('the handle works by keyboard, resets on double-click, and the panel reflows at its narrowest', async () => {
  const { tmp, home, repo } = makeRepo()
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, repo))
    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    const separator = page.getByRole('separator', { name: 'Resize orchestrator panel' })
    await separator.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(separator).toHaveAttribute('aria-valuenow', '356')
    await page.keyboard.press('Shift+ArrowRight')
    await expect(separator).toHaveAttribute('aria-valuenow', '292')
    await page.keyboard.press('End')
    await expect(separator).toHaveAttribute('aria-valuenow', (await separator.getAttribute('aria-valuemax'))!)
    await page.keyboard.press('Enter')
    await expect(separator).toHaveAttribute('aria-valuenow', '340')
    await page.keyboard.press('Home')
    await expect(separator).toHaveAttribute('aria-valuenow', '280')
    expect(await asideWidth(page)).toBeCloseTo(280, 0)

    // A proposal card at the narrowest width: nothing spills sideways and the message box is usable.
    const box = panel.getByRole('textbox', { name: 'Message the orchestrator' })
    await box.fill('Please add two tickets: a login page, and a logout button in the header.')
    await box.press('Enter')
    const card = panel.getByRole('group', { name: 'Proposal: Create 2 tickets in Backlog' })
    await expect(card).toBeVisible()
    // No visible element reaches past the panel's right edge, and the panel itself doesn't scroll sideways.
    const overflow = await panel.evaluate((aside) => {
      const right = aside.getBoundingClientRect().right
      const spill = Array.from(aside.querySelectorAll('*'))
        .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > right + 1)
        .map((el) => el.tagName + ' ' + (el.textContent ?? '').slice(0, 40))
      return aside.scrollWidth > aside.clientWidth ? ['aside scrolls', ...spill] : spill
    })
    expect(overflow).toEqual([])
    await box.fill('still usable')
    await expect(box).toHaveValue('still usable')

    // Double-click resets; collapsing and expanding keeps the width.
    await separator.focus()
    await page.keyboard.press('ArrowLeft')
    await separator.dblclick()
    await expect(separator).toHaveAttribute('aria-valuenow', '340')
    await page.keyboard.press('ArrowLeft')
    await panel.getByRole('button', { name: 'Collapse orchestrator panel' }).click()
    await expect(separator).toHaveCount(0)
    expect(await asideWidth(page)).toBeCloseTo(44, 0)
    await panel.getByRole('button', { name: /^Open orchestrator/ }).click()
    await expect(separator).toHaveAttribute('aria-valuenow', '356')
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
