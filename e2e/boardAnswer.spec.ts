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

test('a question is answered from its board card: the agent gets it, the ticket leaves Needs you, the thread shows it answered', async () => {
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
      env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/board-answer-by-role.json', MAINBUS_TEST_REPO: repo }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Add workspace' }).click()

    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Add hello file')
    await page.getByLabel('In your words').fill('Add hello.txt')
    await page.getByRole('button', { name: 'Create' }).click()

    // The Planner asks where the file goes; the ticket waits on the user.
    await page.getByRole('button', { name: /Add hello file/ }).click()
    await page.getByLabel('First message (starts the lineup)').fill('Please add hello.txt')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()
    await expect(page.locator('[data-event="decision"]')).toContainText('Where should hello.txt go?')
    await page.getByRole('button', { name: /board/ }).click()

    // Answer it from the board card, with a note. Clicking inside the popover does not open the ticket.
    const needsYou = page.getByRole('region', { name: 'Needs you' })
    await expect(needsYou.getByText('Add hello file')).toBeVisible()
    await needsYou.getByRole('button', { name: 'Answer' }).click()
    const popover = page.getByRole('dialog')
    await expect(popover.getByText('Where should hello.txt go?')).toBeVisible()
    await expect(popover.getByText('Recommended')).toBeVisible()
    await popover.getByRole('radio', { name: /docs folder/ }).check()
    await popover.getByRole('textbox', { name: /Note/ }).fill('keep it tidy')
    await expect(page.getByRole('heading', { name: 'Add hello file' })).toHaveCount(0)
    await popover.getByRole('button', { name: 'Answer', exact: true }).click()

    // The ticket leaves Needs you.
    await expect(needsYou.getByText('Add hello file')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'In progress' }).getByText('Add hello file')).toBeVisible()

    // The agent received the answer (it carries on), and the thread's card shows it answered.
    await page.getByRole('region', { name: 'In progress' }).getByText('Add hello file').click()
    await expect(page.getByText('Got your answer, planning it.')).toBeVisible()
    const card = page.locator('[data-event="decision"]')
    await expect(card).toContainText('✓ Answered: docs folder')
    await expect(card).toContainText('keep it tidy')
    await expect(page.getByText(/Decision: Where should hello.txt go\? → docs folder \(you, from the board\)/)).toBeVisible()
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})
