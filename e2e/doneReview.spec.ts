import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * When tickets that ran reach Done, the orchestrator gets one review turn for them: it reads what their agents left
 * behind and proposes a follow-up for the one with a note worth a ticket, and nothing for the other.
 * FakeRuntime, a temporary MAINBUS_HOME and a throwaway repo; never the user's board or data home.
 */

const root = path.resolve(import.meta.dirname, '..')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Mainbus E2E', '-c', 'user.email=e2e@mainbus.test', ...args], {
    cwd,
    windowsHide: true,
    stdio: 'pipe'
  })
}

/** Moves the engine's fake clock on, which runs the timers that fall in between. */
async function advance(app: ElectronApplication, seconds: number): Promise<void> {
  await app.evaluate(async (_electron, ms) => {
    const clock = (globalThis as { __mainbusClock?: { advance(ms: number): Promise<void> } }).__mainbusClock
    if (!clock) throw new Error('The fake clock is not on')
    await clock.advance(ms)
  }, seconds * 1000)
}

async function ticketInReview(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New ticket' }).click()
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('In your words').fill(`Words for ${title}`)
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: new RegExp(title) }).click()
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByText('Ready for review', { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /board/ }).click()
  await expect(page.getByRole('region', { name: 'Review', exact: true }).getByText(title)).toBeVisible()
}

const done = (page: Page) => page.getByRole('region', { name: 'Done', exact: true })
const review = (page: Page) => page.getByRole('region', { name: 'Review', exact: true })

async function moveToDone(page: Page, title: string): Promise<void> {
  await review(page).getByRole('button', { name: new RegExp(title) }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to Done' }).click()
  await expect(review(page).getByText(title)).toHaveCount(0)
  await expect(page.getByText('Cleaning up…')).toHaveCount(0, { timeout: 30_000 })
}

async function openFromDone(page: Page, title: string): Promise<void> {
  await done(page).hover()
  await done(page).getByRole('button', { name: new RegExp(title) }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
}

test('two tickets reach Done: one review turn, one follow-up proposed for the ticket whose handoff asks for it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  let app: ElectronApplication | undefined
  try {
    const home = path.join(tmp, 'home')
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n')
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
        MAINBUS_RUNTIME: 'fake:e2e/fixtures/done-review.json',
        MAINBUS_TEST_REPO: repo,
        // The engine's time stands still until the test moves it: the review turn waits for its two minutes.
        MAINBUS_FAKE_CLOCK: 'now'
      }
    })
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 960))
    await page.getByRole('button', { name: 'Add workspace' }).click()

    await ticketInReview(page, 'Alpha')
    await ticketInReview(page, 'Beta')
    await moveToDone(page, 'Alpha')
    await moveToDone(page, 'Beta')

    // Inside the wait nothing happens; after it, one turn for both.
    await advance(app, 60)
    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    await expect(panel.locator('[data-event="wake"]')).toHaveCount(0)
    await advance(app, 70)
    await expect(panel.locator('[data-event="wake"]')).toHaveCount(1)
    await expect(panel.locator('[data-event="wake"]')).toHaveText('Mainbus: reviewing 2 finished tickets')
    await expect(panel.locator('[data-event="user_message"]')).toHaveCount(0)

    // One card, for the ticket with the note, citing it.
    const cards = panel.getByRole('group', { name: /^Proposal: Create/ })
    await expect(cards).toHaveCount(1)
    await expect(cards.getByText('Follow-up to #1 Alpha')).toBeVisible()
    await expect(panel.locator('[data-event="error"]')).toHaveCount(0)

    // Each ticket's Activity says what the review found.
    await openFromDone(page, 'Alpha')
    await expect(page.getByRole('region', { name: 'Activity' }).getByText('Reviewed by the orchestrator: 1 follow-up proposed')).toBeVisible()
    await page.getByRole('button', { name: /board/ }).click()
    await openFromDone(page, 'Beta')
    await expect(page.getByRole('region', { name: 'Activity' }).getByText('Reviewed by the orchestrator: no follow-ups proposed')).toBeVisible()
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})
