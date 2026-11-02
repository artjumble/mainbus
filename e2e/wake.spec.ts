import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'

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
      MAINBUS_RUNTIME: 'fake:e2e/fixtures/wake-by-role.json',
      MAINBUS_TEST_REPO: repo,
      // The engine's time stands still until the test moves it: the wake turn waits for its five seconds.
      MAINBUS_FAKE_CLOCK: 'now'
    }
  })
  return { app, page: await app.firstWindow() }
}

/** Moves the engine's fake clock on, which runs the timers that fall in between. */
async function advance(app: ElectronApplication, seconds: number): Promise<void> {
  await app.evaluate(async (_electron, ms) => {
    const clock = (globalThis as { __mainbusClock?: { advance(ms: number): Promise<void> } }).__mainbusClock
    if (!clock) throw new Error('The fake clock is not on')
    await clock.advance(ms)
  }, seconds * 1000)
}

async function addAndStart(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New ticket' }).click()
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('In your words').fill(`Do ${title}`)
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: new RegExp(title) }).click()
  await page.getByRole('button', { name: 'Start', exact: true }).click()
}

const panelOf = (page: Page): Locator => page.getByRole('complementary', { name: 'Orchestrator' })

test('a failed agent gives the orchestrator a turn without a message of the user, and a turn cut short by a restart is presented again', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  let session: { app: ElectronApplication; page: Page } | undefined
  try {
    const home = path.join(tmp, 'home')
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'initial')

    session = await launch(home, repo)
    let { app, page } = session
    await page.getByRole('button', { name: 'Open a repo folder' }).click()

    // 1. A scripted agent fails; five seconds later the orchestrator has a turn, and the panel says why under an engine line.
    await addAndStart(page, 'Alpha')
    await page.getByRole('button', { name: /board/ }).click()
    await expect(page.getByRole('region', { name: 'Needs you' }).getByText('Alpha')).toBeVisible()
    await advance(app, 6)
    let panel = panelOf(page)
    await expect(panel.locator('[data-event="wake"]')).toHaveText('Mainbus: 1 thing to look at')
    await expect(panel.getByText("Alpha's Planner failed: the API was down.")).toBeVisible()
    // Nobody wrote to it: no message of the user is in the thread.
    await expect(panel.locator('[data-event="user_message"]')).toHaveCount(0)
    await expect(panel.locator('[data-event="error"]')).toHaveCount(0)

    // 2. A second failure; the orchestrator's turn for it is still under way when the app is closed.
    await addAndStart(page, 'Beta')
    await page.getByRole('button', { name: /board/ }).click()
    await expect(page.getByRole('region', { name: 'Needs you' }).getByText('Beta')).toBeVisible()
    await advance(app, 6)
    await expect(panel.locator('[data-event="wake"]')).toHaveCount(2)
    await expect(panel.getByText("Beta's Planner failed too; looking at it.")).toBeVisible()
    await app.close()

    // 3. On the next launch the same row is presented again, and this time the turn finishes.
    session = await launch(home, repo)
    ;({ app, page } = session)
    await advance(app, 6)
    panel = panelOf(page)
    await expect(panel.getByText("Back after the restart: Beta's Planner failed, and I am on it.")).toBeVisible()
    await expect(panel.locator('[data-event="wake"]')).toHaveCount(3)
    await expect(panel.locator('[data-event="user_message"]')).toHaveCount(0)
    // Alpha's was acknowledged by its finished turn: it was not presented a second time (the fake fails a turn whose digest lacks Beta's).
    await expect(panel.locator('[data-event="error"]')).toHaveCount(0)
  } finally {
    await session?.app.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})
