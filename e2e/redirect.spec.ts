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

test('a stuck agent repeats a failing command, the orchestrator proposes a redirect, the user confirms it and the agent receives it and recovers', async () => {
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
      env: {
        ...env,
        MAINBUS_HOME: home,
        MAINBUS_RUNTIME: 'fake:e2e/fixtures/redirect-by-role.json',
        MAINBUS_TEST_REPO: repo,
        // The engine's time (and the stuck detector's checks) stand still until the test moves them.
        MAINBUS_FAKE_CLOCK: 'now'
      }
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
    await expect(page.getByText('Error: test timed out after 5000ms').first()).toBeVisible()

    // The next check finds the same command failing five times in a row.
    await app.evaluate(async () => {
      const clock = (globalThis as { __mainbusClock?: { advance(ms: number): Promise<void> } }).__mainbusClock
      if (!clock) throw new Error('The fake clock is not on')
      await clock.advance(3 * 60 * 1000)
    })
    await expect(page.locator('[data-stuck-chip]').first()).toBeVisible()
    await expect(page.locator('[data-stuck-evidence]')).toContainText('Bash failed 5 times in a row: npm test')

    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    const box = panel.getByRole('textbox', { name: 'Message the orchestrator' })
    await box.fill('Alpha looks stuck.')
    await box.press('Enter')
    const card = panel.getByRole('group', { name: /^Proposal: Redirect the Planner on #1/ })
    await expect(card.getByText('Bash failed 5 times in a row: npm test')).toBeVisible()
    await expect(card.getByText('Timeouts are ruled out; check the shared fixtures instead.')).toBeVisible()
    // Nothing reaches the agent before the user confirms.
    await expect(page.getByText('Checking the shared fixtures; that was the problem.')).toHaveCount(0)

    await card.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(panel.locator('[data-proposal="receipt"]')).toContainText('Redirected the Planner on #1')

    // The agent received the message once, and recovered.
    await expect(page.getByText('Checking the shared fixtures; that was the problem.')).toHaveCount(1)
    await expect(page.locator('[data-event="redirected"]')).toContainText('Timeouts are ruled out; check the shared fixtures instead.')
    await expect(page.locator('[data-event="redirected"]')).toContainText('Mainbus')
    // Only the user's own first message is theirs; the redirect is Mainbus's.
    await expect(page.getByRole('main').locator('[data-event="user_message"]')).toHaveCount(1)
    await expect(
      page.getByText('Redirected Planner: Timeouts are ruled out; check the shared fixtures instead. (suggested by the orchestrator, confirmed by you)')
    ).toHaveCount(1)
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})
