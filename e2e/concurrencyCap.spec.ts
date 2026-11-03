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
    env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/cap-by-role.json', MAINBUS_TEST_REPO: repo }
  })
  const page = await app.firstWindow()
  return { app, page }
}

async function createTicket(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New ticket' }).click()
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('In your words').fill(title)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible()
}

test('with room for one agent, the second ticket shows Queued and starts when the first reaches Review', async () => {
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

    // The cap is three until the user changes it in the general settings; set it to one.
    await page.getByRole('button', { name: 'Workspace settings' }).click()
    const cap = page.getByRole('textbox', { name: 'Agents running at once' })
    await expect(cap).toHaveValue('3')
    await cap.fill('1')
    await expect(cap).toHaveValue('1')
    await expect(cap).toBeEnabled()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Workspace settings' }).click()
    await expect(page.getByRole('textbox', { name: 'Agents running at once' })).toHaveValue('1')
    await page.keyboard.press('Escape')

    // The first ticket's Planner hands off at once; its Implementer then holds the only slot.
    await createTicket(page, 'First ticket')
    await createTicket(page, 'Second ticket')
    await page.getByRole('button', { name: /First ticket/ }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByText('Implementer: adding the file.')).toBeVisible()

    // The second can't start: it shows Queued, first in line, in progress with its phase unchanged.
    await page.getByRole('button', { name: /board/ }).click()
    await page.getByRole('button', { name: /Second ticket/ }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByText('Queued · 1st').first()).toBeVisible()
    await expect(page.getByRole('list', { name: 'Lineup' }).getByRole('listitem')).toHaveText(
      ['Planner Queued · 1st', 'Implementer ○ Not started', 'Reviewer ○ Not started'],
      { useInnerText: true }
    )
    await page.getByRole('button', { name: /board/ }).click()
    const inProgress = page.getByRole('region', { name: 'In progress' })
    await expect(inProgress.getByText('Second ticket')).toBeVisible()
    await expect(inProgress.getByText('Queued · 1st')).toBeVisible()
    await expect(inProgress.getByText('Planner: reading the ticket.')).toHaveCount(0)

    // The first ticket's Implementer finishes; the Reviewer hands off at once and it reaches Review.
    await page.getByRole('button', { name: /First ticket/ }).click()
    await page.getByLabel('Message the Implementer').fill('Go ahead')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()
    await expect(page.getByText('Ready for review', { exact: true })).toBeVisible()

    // The slot is free: the second ticket's agents start, and it is no longer queued.
    await page.getByRole('button', { name: /board/ }).click()
    await expect(page.getByRole('region', { name: 'Review' }).getByText('First ticket')).toBeVisible()
    await page.getByRole('button', { name: /Second ticket/ }).click()
    await expect(page.getByText('Implementer: adding the file.')).toBeVisible()
    await expect(page.getByText(/^Queued/)).toHaveCount(0)
    await expect(page.getByRole('list', { name: 'Lineup' }).getByRole('listitem')).toHaveText(
      ['Planner ✓ Handed off', 'Implementer • Working', 'Reviewer ○ Not started'],
      { useInnerText: true }
    )
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
