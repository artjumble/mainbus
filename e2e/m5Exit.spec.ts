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

/** Moves the engine's fake clock on, which runs the stuck detector's checks that fall in between. */
async function advance(app: ElectronApplication, minutes: number): Promise<void> {
  await app.evaluate(async (_electron, ms) => {
    const clock = (globalThis as { __mainbusClock?: { advance(ms: number): Promise<void> } }).__mainbusClock
    if (!clock) throw new Error('The fake clock is not on')
    await clock.advance(ms)
  }, minutes * 60 * 1000)
}

test('M5 exit: a looping agent is detected, redirected, detected again and replaced, and the replacement finishes the ticket', async () => {
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
        MAINBUS_RUNTIME: 'fake:e2e/fixtures/m5-exit-by-role.json',
        MAINBUS_TEST_REPO: repo,
        // The engine's time (and the stuck detector's checks) stand still until the test moves them.
        MAINBUS_FAKE_CLOCK: 'now'
      }
    })
    const page: Page = await app.firstWindow()
    await page.getByRole('button', { name: 'Open a repo folder' }).click()
    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Alpha')
    await page.getByLabel('In your words').fill('Fix the flaky test')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('button', { name: /Alpha/ }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()

    // The Planner hands off at once; the Implementer then loops on a failing command.
    await expect(page.getByText('Error: test timed out after 5000ms').first()).toBeVisible()
    const activity = page.getByRole('region', { name: 'Activity' })

    // 1. The detector fires.
    await advance(app, 3)
    await expect(page.locator('[data-stuck-chip]').first()).toBeVisible()
    await expect(page.locator('[data-stuck-evidence]')).toContainText('Bash failed 5 times in a row: npm test')
    await expect(activity.getByText('Implementer looks stuck: same failing command 5 times (detected by Mainbus)')).toBeVisible()

    // 2. Mainbus gives the orchestrator a turn of its own (no message of the user), and it proposes a redirect; the user confirms it.
    await advance(app, 0.2)
    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    await expect(panel.locator('[data-event="wake"]').first()).toHaveText('Mainbus: 1 thing to look at')
    const redirect = panel.getByRole('group', { name: /^Proposal: Redirect the Implementer on #1/ })
    await redirect.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(panel.locator('[data-proposal="receipt"]')).toContainText('Redirected the Implementer on #1')
    await expect(page.locator('[data-event="redirected"]')).toContainText('Timeouts are ruled out; check the shared fixtures instead.')

    // 3. The agent keeps looping, and the detector fires again (hits are at least five minutes apart).
    await expect(page.getByRole('main').getByText('Error: test timed out after 5000ms', { exact: true })).toHaveCount(10)
    await advance(app, 6)
    await expect(activity.getByText('Implementer still looks stuck after the redirect: same failing command 10 times (detected by Mainbus)')).toBeVisible()

    // 4. The agent fired again: the orchestrator is woken again, proposes a replacement, and the user confirms it.
    await advance(app, 1)
    await expect(panel.locator('[data-event="wake"]')).toHaveCount(2)
    const replace = panel.getByRole('group', { name: /^Proposal: Replace the Implementer on #1/ })
    await replace.getByRole('button', { name: 'Replace Implementer' }).click()
    await expect(panel.locator('[data-proposal="receipt"]').last()).toContainText('Replaced the Implementer on #1')

    // 5. The replacement receives the handoff summary (the fake fails its run if it doesn't) and finishes; 6. the ticket reaches Review.
    await expect(page.getByText('Picked up from the handoff; fixing the fixtures.')).toBeVisible()
    await expect(page.getByText('Reviewer: the fix looks right.')).toBeVisible()
    await expect(page.locator('[data-event="error"]')).toHaveCount(0)

    // The thread: the divider, and the handoff block collapsed until opened.
    await expect(page.locator('[data-event="replaced"]')).toContainText('Implementer replaced')
    const block = page.getByRole('button', { name: /Handoff from the previous run/ })
    await expect(block).toHaveAttribute('aria-expanded', 'false')
    // Only the Activity's clipped copy shows the summary while the block is closed.
    await expect(page.getByText('A summary the fake runtime wrote.')).toHaveCount(1)
    await block.click()
    await expect(page.getByText('A summary the fake runtime wrote.')).toHaveCount(2)
    // The role appears once in the lineup, with the marker.
    await expect(page.getByRole('list', { name: 'Lineup' }).getByRole('listitem')).toHaveCount(3)
    await expect(page.locator('[data-replaced]')).toHaveText('replaced ×1')

    // View previous run: the old run's rows and the redirect, read-only; and the way back.
    await page.getByRole('button', { name: 'View previous run' }).last().click()
    const previous = page.getByRole('region', { name: 'Previous run of the Implementer' })
    await expect(previous.getByText('Error: test timed out after 5000ms')).toHaveCount(10)
    await expect(previous.locator('[data-event="redirected"]')).toBeVisible()
    await expect(previous.getByText('Picked up from the handoff; fixing the fixtures.')).toHaveCount(0)
    await expect(page.getByRole('main').getByRole('textbox', { name: /^Message/ })).toHaveCount(0)
    await page.getByRole('button', { name: '← Back to the live thread' }).click()
    await expect(page.getByText('Picked up from the handoff; fixing the fixtures.')).toBeVisible()
    await expect(previous).toHaveCount(0)

    // Activity has every step, with who suggested and who confirmed.
    await expect(activity.getByText('Implementer looks stuck: same failing command 5 times (detected by Mainbus)')).toBeVisible()
    await expect(
      activity.getByText('Redirected Implementer: Timeouts are ruled out; check the shared fixtures instead. (suggested by the orchestrator, confirmed by you)')
    ).toBeVisible()
    await expect(activity.getByText('Implementer still looks stuck after the redirect: same failing command 10 times (detected by Mainbus)')).toBeVisible()
    await expect(activity.getByText('Replaced Implementer (suggested by the orchestrator, confirmed by you)')).toBeVisible()
    await expect(activity.getByText('Handed off').first()).toBeVisible()
    await expect(activity.getByRole('button', { name: 'View proposal' })).toHaveCount(2)

    // The ticket is in Review.
    await page.getByRole('button', { name: /board/ }).click()
    await expect(page.getByRole('region', { name: 'Review' }).getByText('Alpha')).toBeVisible()
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})
