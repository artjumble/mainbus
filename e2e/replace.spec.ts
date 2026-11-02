import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '..')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Mainbus E2E', '-c', 'user.email=e2e@mainbus.test', ...args], {
    cwd,
    windowsHide: true,
    stdio: 'pipe'
  })
}

test('the user replaces the working agent from the ticket view: the card opens, the new agent starts from a summary of the old one', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  let app: ElectronApplication | undefined
  try {
    const home = path.join(tmp, 'home')
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'initial')

    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env['ELECTRON_RUN_AS_NODE']
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/replace-by-role.json', MAINBUS_TEST_REPO: repo }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Open a repo folder' }).click()

    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Alpha')
    await page.getByLabel('In your words').fill('Fix the flaky test')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('button', { name: /Alpha/ }).click()
    await page.getByLabel('First message (starts the lineup)').fill('Please fix the flaky test')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()
    await expect(page.getByText('Planner at work on the flaky test.')).toHaveCount(1)

    // No stuck episode: the user's own Replace… opens the same card anyway.
    await page.getByRole('main').getByRole('button', { name: 'Replace…' }).click()
    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    const card = panel.getByRole('group', { name: /^Proposal: Replace the Planner on #1/ })
    for (const name of ['Keep current', 'Override', 'Replace Planner']) await expect(card.getByRole('button', { name })).toBeVisible()
    // Nothing changes before the user decides.
    await expect(page.getByText('Planner at work on the flaky test.')).toHaveCount(1)

    await card.getByRole('button', { name: 'Replace Planner' }).click()
    await expect(panel.locator('[data-proposal="receipt"]')).toContainText('Replaced the Planner on #1')

    // The old agent's summary is in the thread, and a fresh Planner is at work.
    await expect(page.locator('[data-event="replaced"]')).toContainText('Mainbus · Replaced Planner')
    await expect(page.locator('[data-event="replaced"]')).toContainText('A summary the fake runtime wrote.')
    await expect(page.getByText('Planner at work on the flaky test.')).toHaveCount(2)
    await expect(page.getByText('Replaced Planner (confirmed by you)')).toHaveCount(1)
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})
