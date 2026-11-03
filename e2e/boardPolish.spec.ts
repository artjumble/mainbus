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
      // The Planner hands off on the first message; the Implementer then waits for another.
      MAINBUS_RUNTIME: 'fake:e2e/fixtures/ask-then-handoff-by-role.json',
      MAINBUS_TEST_REPO: repo
    }
  })
  const page = await app.firstWindow()
  return { app, page }
}

async function createTicket(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New ticket' }).click()
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('In your words').fill(`Words for ${title}`)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible()
}

test('welcome, empty workspace, search, and the first message on a new ticket', async () => {
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

    // A fresh data home: the welcome. Adding the repo shows the empty workspace.
    await expect(page.getByRole('heading', { name: 'Welcome to Mainbus' })).toBeVisible()
    await page.getByRole('button', { name: 'Add workspace' }).click()
    await expect(page.getByRole('heading', { name: /No tickets in .* yet/ })).toBeVisible()

    // "Ask orchestrator to draft tickets" opens the panel with the box filled in and focused.
    await page.getByRole('button', { name: 'Ask orchestrator to draft tickets' }).click()
    const box = page.getByRole('complementary', { name: 'Orchestrator' }).getByLabel('Message the orchestrator')
    await expect(box).toHaveValue('Draft tickets for ')
    await expect(box).toBeFocused()

    // Two tickets; search narrows the board and Escape restores it.
    await createTicket(page, 'Add hello file')
    await createTicket(page, 'Fix login bug')
    const search = page.getByRole('textbox', { name: 'Search tickets' })
    await search.fill('login')
    await expect(page.getByRole('button', { name: /Fix login bug/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Add hello file/ })).toHaveCount(0)
    await expect(page.getByText('No matches').first()).toBeVisible()
    await search.press('Escape')
    await expect(search).toHaveValue('')
    await expect(page.getByRole('button', { name: /Add hello file/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Fix login bug/ })).toBeVisible()

    // A ticket with no agent: Start, Adjust before starting, and a first message that starts the lineup.
    await page.getByRole('button', { name: /Add hello file/ }).click()
    await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Adjust before starting' })).toBeVisible()
    await page.getByLabel('First message (starts the lineup)').fill('Please add hello.txt')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()
    await expect(page.getByText('Implementing', { exact: true })).toBeVisible()
    await expect(page.getByText('Looking at the repo before I add hello.txt.')).toBeVisible()
  } finally {
    await session?.app.close().catch(() => {})
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
  }
})
