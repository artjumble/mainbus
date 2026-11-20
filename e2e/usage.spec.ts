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
    env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/usage-by-role.json', MAINBUS_TEST_REPO: repo }
  })
  const page = await app.firstWindow()
  return { app, page }
}

test("a ticket's view shows its usage and where its time went, per role, after its run; the card shows neither; the workspace report shows the median", async () => {
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

    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Add hello')
    await page.getByLabel('In your words').fill('Add hello.txt')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('region', { name: 'Backlog' }).getByText('Add hello').click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await page.getByRole('button', { name: /board$/ }).click()

    const review = page.getByRole('region', { name: 'Review' })
    await expect(review.getByText('Add hello')).toBeVisible({ timeout: 30_000 })
    // Never on the card.
    await expect(review.getByText(/token|input|\$\d/i)).toHaveCount(0)
    await expect(review.getByText(/\bmins?\b|\btime\b/i)).toHaveCount(0)
    await review.getByText('Add hello').click()

    const usage = page.getByRole('region', { name: 'Usage' })
    await expect(usage.getByRole('button', { name: 'Show' })).toHaveAttribute('aria-expanded', 'false')
    await usage.getByRole('button', { name: 'Show' }).click()
    // 100 + 200 + 300 input over the three roles, three turns of a minute each, $0.10 each.
    await expect(usage.getByText('600 input · 30 output · 3k cache read · 0 cache write · 3 turns · 3m')).toBeVisible()
    await expect(usage.getByText('$0.30')).toBeVisible()
    await expect(usage.getByText('API-equivalent cost, not billed on your Claude plan').first()).toBeVisible()
    for (const role of ['Planner', 'Implementer', 'Reviewer']) await expect(usage.getByText(role, { exact: true })).toBeVisible()

    // Where the time went, from the same run.
    const time = page.getByRole('region', { name: 'Time' })
    await expect(time.getByRole('button', { name: 'Show' })).toHaveAttribute('aria-expanded', 'false')
    await time.getByRole('button', { name: 'Show' }).click()
    await expect(time.getByText(/from the first start to Review/)).toBeVisible()
    await expect(time.getByText(/pnpm test × 1/)).toBeVisible()
    for (const role of ['Planner', 'Implementer', 'Reviewer']) await expect(time.getByText(role, { exact: true })).toBeVisible()

    // The workspace report. Its Export CSV opens a native save dialog, so it is only checked for being there.
    await page.getByRole('button', { name: /board$/ }).click()
    await page.getByRole('button', { name: 'Workspace settings' }).click()
    const report = page.getByRole('region', { name: 'Where time goes' })
    await expect(report.getByText(/1 ticket · .* median /)).toBeVisible()
    await expect(report.getByRole('button', { name: 'Export CSV' })).toBeVisible()
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
