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

test('an agent asks, the orchestrator proposes an answer, the user confirms it, the agent hears it once and the decision is resolved everywhere', async () => {
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
      env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/orchestrator-answer.json', MAINBUS_TEST_REPO: repo }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Open a repo folder' }).click()

    // A started ticket whose Planner asks where the file goes.
    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Alpha')
    await page.getByLabel('In your words').fill('Add hello.txt')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('button', { name: /Alpha/ }).click()
    await page.getByLabel('First message (starts the lineup)').fill('Please add hello.txt')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()
    await expect(page.locator('[data-event="decision"]')).toContainText('Where should hello.txt go?')
    await page.getByRole('button', { name: /board/ }).click()

    const needsYou = page.getByRole('region', { name: 'Needs you' })
    const waiting = page.getByRole('region', { name: 'Waiting on you' })
    await expect(needsYou.getByRole('button', { name: /Alpha/ })).toBeVisible()
    await expect(waiting.locator('[data-event="waiting-decision"]')).toHaveCount(1)

    // The orchestrator recommends the docs folder.
    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    const box = panel.getByRole('textbox', { name: 'Message the orchestrator' })
    await box.fill('hello.txt belongs in the docs folder.')
    await box.press('Enter')
    await expect(panel.getByText("I've recommended the docs folder.")).toBeVisible()
    const card = panel.getByRole('group', { name: 'Proposal: Answer #1: Where should hello.txt go?' })
    await expect(card.getByText('Recommended answer: docs folder')).toBeVisible()
    await expect(card.getByText('Why: You said hello.txt belongs in the docs folder.')).toBeVisible()
    // Nothing is answered before the user confirms.
    await expect(waiting.locator('[data-event="waiting-decision"]')).toHaveCount(1)

    await card.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(panel.locator('[data-proposal="receipt"]')).toContainText('Answered #1 with "docs folder"')

    // Resolved in all three places: the board's Needs you, the panel's group and the ticket's thread.
    await expect(needsYou.getByRole('button', { name: /Alpha/ })).toHaveCount(0)
    await expect(waiting.locator('[data-event="waiting-decision"]')).toHaveCount(0)
    await page.getByRole('region', { name: 'In progress' }).getByText('Alpha').click()
    await expect(page.locator('[data-event="decision"]')).toContainText('✓ Answered: docs folder')
    // The agent heard it, once.
    await expect(page.getByText('Got your answer, planning it.')).toHaveCount(1)
    await expect(page.getByText('Decision: Where should hello.txt go? → docs folder (you, from the orchestrator panel)')).toHaveCount(1)
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})
