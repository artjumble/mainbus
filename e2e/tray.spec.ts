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

interface Session {
  app: ElectronApplication
  page: Page
  /** Resolves with the exit code when the process ends on its own. */
  exited: Promise<number | null>
}

async function launch(home: string, repo: string, fixture: string, extra: Record<string, string> = {}): Promise<Session> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: `fake:e2e/fixtures/${fixture}`, MAINBUS_TEST_REPO: repo, ...extra }
  })
  const child = app.process()
  const exited = new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode)
    else child.once('exit', (code) => resolve(code))
  })
  return { app, page: await app.firstWindow(), exited }
}

/** Waits for the app's own exit (never ends the process): fails if it doesn't happen by itself. */
async function exitsByItself(s: Session): Promise<number | null> {
  return Promise.race([
    s.exited,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The app did not exit on its own')), 20_000))
  ])
}

const isVisible = (app: ElectronApplication): Promise<boolean> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)

type Hook = {
  tooltip(): string
  trayClick(): void
  choose(label: string): void
  notifications(): { title: string; body: string }[]
  clickNotification(i: number): void
}
const tray = <T>(app: ElectronApplication, fn: (hook: Hook) => T): Promise<T> =>
  app.evaluate((_, source) => {
    const hook = (globalThis as unknown as { __mainbusTray: Hook }).__mainbusTray
    return (new Function('hook', `return (${source})(hook)`) as (h: Hook) => T)(hook)
  }, fn.toString())

function makeRepo(tmp: string): { home: string; repo: string } {
  const home = path.join(tmp, 'home')
  const repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')
  return { home, repo }
}

function cleanup(tmp: string | null): void {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

async function createTicket(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New ticket' }).click()
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('In your words').fill(title)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible()
}

test('closing the window with an agent working keeps it running in the tray; the tray reopens the same board and Quit stops it cleanly', async () => {
  let tmp: string | null = null
  let session: Session | null = null
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
    const { home, repo } = makeRepo(tmp)
    session = await launch(home, repo, 'tray-by-role.json')
    const { app, page } = session
    await page.getByRole('button', { name: 'Open a repo folder' }).click()
    await createTicket(page, 'Alpha ticket')
    await page.getByRole('button', { name: /Alpha ticket/ }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByText('Planner: on it.')).toBeVisible()
    await page.getByRole('button', { name: /board/ }).click()
    await expect(page.getByRole('region', { name: 'In progress' }).getByText('Alpha ticket')).toBeVisible()
    await expect.poll(() => tray(app, (h) => h.tooltip())).toBe('Mainbus: 1 working')

    // Closing hides the window; the process and the agent go on, and the first time says so.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
    await expect.poll(() => isVisible(app)).toBe(false)
    expect(session.app.process().exitCode).toBeNull()
    expect(await tray(app, (h) => h.tooltip())).toBe('Mainbus: 1 working')
    expect(await tray(app, (h) => h.notifications())).toEqual([
      { title: 'Mainbus is still running', body: 'Agents keep working. Quit from the tray icon.' }
    ])

    // A click on the tray icon brings the same board back, the card still In progress, and the same agent answers.
    await tray(app, (h) => h.trayClick())
    await expect.poll(() => isVisible(app)).toBe(true)
    await expect(page.getByRole('region', { name: 'In progress' }).getByText('Alpha ticket')).toBeVisible()
    await page.getByRole('button', { name: /Alpha ticket/ }).click()
    await page.getByLabel('Message the Planner').fill('Are you there?')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()
    await expect(page.getByText('Planner: still here.')).toBeVisible()

    // Quit from the tray menu ends the process on its own, with a clean exit.
    await tray(app, (h) => h.choose('Quit')).catch(() => {})
    expect(await exitsByItself(session)).toBe(0)

    // The agent resumes on the next launch.
    session = await launch(home, repo, 'tray-by-role.json')
    await session.page.getByRole('button', { name: /Alpha ticket/ }).click()
    await expect(session.page.getByText('Planner: back after the restart.')).toBeVisible()
  } finally {
    await session?.app.close().catch(() => {})
    cleanup(tmp)
  }
})

test('closing the window with no agent open quits as before', async () => {
  let tmp: string | null = null
  let session: Session | null = null
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
    const { home, repo } = makeRepo(tmp)
    session = await launch(home, repo, 'tray-by-role.json')
    await session.page.getByRole('button', { name: 'Open a repo folder' }).click()
    await createTicket(session.page, 'Idle ticket')
    await session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
    expect(await exitsByItself(session)).toBe(0)
  } finally {
    await session?.app.close().catch(() => {})
    cleanup(tmp)
  }
})

test('a ticket reaching Needs you while the window is hidden gets one toast, and clicking it opens the ticket', async () => {
  let tmp: string | null = null
  let session: Session | null = null
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
    const { home, repo } = makeRepo(tmp)
    session = await launch(home, repo, 'board-answer-by-role.json', { MAINBUS_FAKE_CLOCK: 'now' })
    const { app, page } = session
    await page.getByRole('button', { name: 'Open a repo folder' }).click()
    await createTicket(page, 'Add hello file')
    await page.getByRole('button', { name: /Add hello file/ }).click()
    await page.getByLabel('First message (starts the lineup)').fill('Please add hello.txt')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()
    await expect(page.locator('[data-event="decision"]')).toContainText('Where should hello.txt go?')
    await page.getByRole('button', { name: /board/ }).click()
    await expect.poll(() => tray(app, (h) => h.tooltip())).toContain('1 needs you')

    // Later… > Tomorrow: the decision leaves Needs you, and the agent is still open, so closing hides the window.
    const needsYou = page.getByRole('region', { name: 'Needs you' })
    await needsYou.getByRole('button', { name: 'Answer' }).click()
    const popover = page.getByRole('dialog')
    await popover.getByRole('button', { name: 'Later…' }).click()
    await popover.getByRole('menuitem', { name: 'Tomorrow' }).click()
    await expect(needsYou.getByText('Add hello file')).toHaveCount(0)
    await expect.poll(() => tray(app, (h) => h.tooltip())).not.toContain('needs you')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
    await expect.poll(() => isVisible(app)).toBe(false)
    expect(app.process().exitCode).toBeNull()

    // Two days on, the decision is back in Needs you: one toast, and clicking it shows the ticket.
    await app.evaluate(async () => {
      const clock = (globalThis as { __mainbusClock?: { advance(ms: number): Promise<void> } }).__mainbusClock
      if (!clock) throw new Error('The fake clock is not on')
      await clock.advance(2 * 24 * 60 * 60 * 1000)
    })
    await expect.poll(async () => (await tray(app, (h) => h.notifications())).map((n) => n.title)).toContain('#1 needs you')
    expect((await tray(app, (h) => h.notifications())).filter((n) => n.title === '#1 needs you')).toHaveLength(1)
    const index = (await tray(app, (h) => h.notifications())).findIndex((n) => n.title === '#1 needs you')
    await app.evaluate((_, i) => (globalThis as unknown as { __mainbusTray: Hook }).__mainbusTray.clickNotification(i), index)
    await expect.poll(() => isVisible(app)).toBe(true)
    await expect(page.getByRole('heading', { name: 'Add hello file' })).toBeVisible()
    await expect(page.locator('[data-event="decision"]')).toContainText('Where should hello.txt go?')
  } finally {
    await session?.app.close().catch(() => {})
    cleanup(tmp)
  }
})
