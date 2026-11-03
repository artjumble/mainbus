import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '..')

/** The engine's clock starts here; the fixture's rejected event says the limit resets an hour later. */
const NOW = '2026-11-02T09:00:00.000Z'
const RESET = new Date('2026-11-02T10:00:00.000Z')

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
      MAINBUS_RUNTIME: 'fake:e2e/fixtures/usage-limit-by-role.json',
      MAINBUS_TEST_REPO: repo,
      // The engine's time stands still until the test moves it: the reset comes when the clock reaches it.
      MAINBUS_FAKE_CLOCK: NOW
    }
  })
  return { app, page: await app.firstWindow() }
}

async function advance(app: ElectronApplication, ms: number): Promise<void> {
  await app.evaluate(async (_electron, by) => {
    const clock = (globalThis as { __mainbusClock?: { advance(ms: number): Promise<void> } }).__mainbusClock
    if (!clock) throw new Error('The fake clock is not on')
    await clock.advance(by)
  }, ms)
}

async function createTicket(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New ticket' }).click()
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('In your words').fill(title)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible()
}

/** The local time of day as the app shows it. */
function clockTime(d: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

test('a usage limit pauses both working tickets with the reset time, and at the reset they resume in order and finish', async () => {
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
    const { app, page } = session
    await page.getByRole('button', { name: 'Add workspace' }).click()

    // Two tickets, both working.
    await createTicket(page, 'First ticket')
    await createTicket(page, 'Second ticket')
    await page.getByRole('button', { name: /First ticket/ }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByText('Planner: reading the ticket.')).toBeVisible()
    await page.getByRole('button', { name: /board/ }).click()
    await page.getByRole('button', { name: /Second ticket/ }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByText('Planner: reading the ticket.')).toBeVisible()

    // Room for one agent from now on: lowering the cap stops nothing, but only one may run once they resume.
    await page.getByRole('button', { name: /board/ }).click()
    await page.getByRole('button', { name: 'Workspace settings' }).click()
    const cap = page.getByRole('textbox', { name: 'Agents running at once' })
    await cap.fill('1')
    await expect(cap).toHaveValue('1')
    await expect(cap).toBeEnabled()
    await page.keyboard.press('Escape')

    // The first ticket's Planner runs into the limit.
    await page.getByRole('button', { name: /First ticket/ }).click()
    await page.getByLabel('Message the Planner').fill('Go ahead')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()

    // Both tickets pause with the reason and the reset time; nothing needs the user, and the banner says so.
    const at = clockTime(RESET)
    const banner = page.getByRole('status', { name: 'Usage limit' })
    await expect(banner).toHaveText(new RegExp(`Usage limit reached\\. 2 agents paused; resuming at ${at}\\.`))
    await page.getByRole('button', { name: /board/ }).click()
    const inProgress = page.getByRole('region', { name: 'In progress' })
    await expect(inProgress.getByText('First ticket')).toBeVisible()
    await expect(inProgress.getByText('Second ticket')).toBeVisible()
    await expect(inProgress.getByText(`Usage limit; resumes at ${at}`)).toHaveCount(2)
    await expect(inProgress.getByText('Paused', { exact: true })).toHaveCount(2)
    await expect(page.getByRole('region', { name: 'Needs you' }).getByRole('button')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Needs you' }).getByText('First ticket')).toHaveCount(0)

    // The clock reaches the reset: the first ticket, paused first, resumes; the second waits for the only slot.
    await advance(app, 60 * 60 * 1000)
    await expect(inProgress.getByText('Queued · 1st')).toBeVisible()
    await expect(banner).toBeEmpty()
    await page.getByRole('button', { name: /First ticket/ }).click()
    await expect(page.getByText('Planner: back after the reset.')).toBeVisible()
    await page.getByLabel('Message the Planner').fill('Carry on')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()

    // The first reaches Review, then the second starts and finishes the same way.
    await page.getByRole('button', { name: /board/ }).click()
    await expect(page.getByRole('region', { name: 'Review' }).getByText('First ticket')).toBeVisible()
    await page.getByRole('button', { name: /Second ticket/ }).click()
    await expect(page.getByText('Planner: back after the reset.')).toBeVisible()
    await page.getByLabel('Message the Planner').fill('Carry on')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()
    await page.getByRole('button', { name: /board/ }).click()
    const review = page.getByRole('region', { name: 'Review' })
    await expect(review.getByText('First ticket')).toBeVisible()
    await expect(review.getByText('Second ticket')).toBeVisible()
    await expect(banner).toBeEmpty()
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
