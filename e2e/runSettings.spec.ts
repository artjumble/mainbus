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

async function launch(home: string, repo: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: {
      ...env,
      MAINBUS_HOME: home,
      // The Planner fails if it runs; the Implementer fails unless it runs on Opus, high.
      MAINBUS_RUNTIME: 'fake:e2e/fixtures/run-settings-by-role.json',
      MAINBUS_TEST_REPO: repo
    }
  })
  const page = await app.firstWindow()
  return { app, page }
}

test("a Backlog ticket's saved run settings are what unattended mode starts it with once it is in Ready", async () => {
  let tmp: string | null = null
  let session: { app: ElectronApplication; page: Page } | null = null
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
    const home = path.join(tmp, 'home')
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init')
    fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'initial')

    session = await launch(home, repo)
    const { page } = session
    await page.getByRole('button', { name: 'Add workspace' }).click()

    // A Backlog ticket.
    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Add hello file')
    await page.getByLabel('In your words').fill('Add hello.txt')
    await page.getByRole('button', { name: 'Create' }).click()
    const backlog = page.getByRole('region', { name: 'Backlog' })
    await backlog.getByText('Add hello file').click()

    // Its run settings, without starting it: no Planner, and the Implementer on Opus, high.
    const settings = page.getByRole('region', { name: 'Run settings' })
    await expect(settings.getByText('Lineup defaults')).toBeVisible()
    await settings.getByRole('button', { name: 'Edit' }).click()
    await settings.getByRole('checkbox', { name: '1. Planner' }).uncheck()
    await settings.getByRole('button', { name: /Models and effort per role/ }).click()
    await settings.getByRole('combobox', { name: 'Model for Implementer' }).selectOption('opus')
    await settings.getByRole('combobox', { name: 'Effort for Implementer' }).selectOption('high')
    await settings.getByRole('button', { name: 'Save' }).click()
    await expect(settings.getByText('Implementer, Reviewer · Implementer on Opus, high')).toBeVisible()
    // Saving doesn't start it.
    await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible()

    // Back on the board: the card shows the custom run, still in Backlog.
    await page.getByRole('button', { name: /board$/ }).click()
    await expect(backlog.getByText('Custom run')).toBeVisible()

    // Unattended mode on, with nothing in Ready yet.
    await page.getByRole('switch', { name: 'Unattended' }).check()
    await expect(page.getByTestId('unattended-status')).toHaveText('Waiting for Ready tickets')

    // Move the card into Ready with the keyboard: Space picks it up, Arrow Right moves it a column, Space drops it.
    const announced = page.locator('[id^="DndLiveRegion"]')
    await page.getByRole('button', { name: /Move ticket #1/ }).focus()
    await page.keyboard.press('Space')
    await expect(announced).toContainText('Picked up ticket #1 Add hello file')
    await page.waitForTimeout(200)
    await page.keyboard.press('ArrowRight')
    await expect(announced).toContainText('ticket #1 Add hello file is over Ready')
    await page.keyboard.press('Space')

    // Unattended mode starts it with the saved settings, and it goes through to Review.
    const review = page.getByRole('region', { name: 'Review' })
    await expect(review.getByText('Add hello file')).toBeVisible({ timeout: 30_000 })
    await review.getByText('Add hello file').click()
    const lineup = page.getByRole('list', { name: 'Lineup' })
    await expect(lineup.getByRole('listitem')).toHaveCount(2)
    await expect(lineup.getByText('Implementer')).toBeVisible()
    await expect(lineup.getByText('Reviewer')).toBeVisible()
    await expect(lineup.getByText('Planner')).toHaveCount(0)
    await expect(page.getByText('Implementer on Opus, high.')).toBeVisible()
    await expect(page.getByText('The launch has model')).toHaveCount(0)
    await expect(page.getByText('The Planner ran')).toHaveCount(0)
    // The settings are kept for the next start.
    await expect(page.getByRole('region', { name: 'Run settings' }).getByText('Implementer, Reviewer · Implementer on Opus, high')).toBeVisible()
  } finally {
    await session?.app.close().catch(() => {})
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // A temp folder left behind is harmless.
      }
    }
  }
})
