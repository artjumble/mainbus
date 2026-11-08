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
      // The Planner and Reviewer fail if they run; the Implementer fails unless it runs on Sonnet, medium.
      MAINBUS_RUNTIME: 'fake:e2e/fixtures/docs-preset-by-role.json',
      MAINBUS_TEST_REPO: repo
    }
  })
  const page = await app.firstWindow()
  return { app, page }
}

test('a ticket created with the Docs preset starts with only the Implementer, on Sonnet at medium effort', async () => {
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

    // The workspace's presets are listed in its settings.
    await page.getByRole('button', { name: 'Workspace settings' }).click()
    const presets = page.getByRole('list', { name: 'Presets' })
    await expect(presets.getByRole('listitem')).toHaveCount(3)
    await expect(presets.getByRole('button', { name: 'Edit Docs' })).toBeVisible()
    await page.keyboard.press('Escape')

    // A new ticket with the Docs preset.
    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Document hello')
    await page.getByLabel('In your words').fill('Document hello.txt')
    await page.getByLabel('Preset').selectOption('Docs')
    await page.getByRole('button', { name: 'Create' }).click()
    const backlog = page.getByRole('region', { name: 'Backlog' })
    await expect(backlog.getByText('Custom run')).toBeVisible()
    await backlog.getByText('Document hello').click()

    // Start it: only the Implementer runs, on Sonnet at medium effort, and it goes through to Review.
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await page.getByRole('button', { name: /board$/ }).click()
    const review = page.getByRole('region', { name: 'Review' })
    await expect(review.getByText('Document hello')).toBeVisible({ timeout: 30_000 })
    await review.getByText('Document hello').click()
    const lineup = page.getByRole('list', { name: 'Lineup' })
    await expect(lineup.getByRole('listitem')).toHaveCount(1)
    await expect(lineup.getByText('Implementer')).toBeVisible()
    await expect(page.getByText('Implementer on Sonnet, medium.')).toBeVisible()
    await expect(page.getByText('The launch has model')).toHaveCount(0)
    await expect(page.getByText('The Planner ran')).toHaveCount(0)
    await expect(page.getByText('The Reviewer ran')).toHaveCount(0)
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
