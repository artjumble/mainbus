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

const TITLES = ['Alpha', 'Beta', 'Gamma']

test('M4 exit, part one: three decisions answered from the board, the panel and the thread each resolve everywhere, and the agent hears each once', async () => {
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
    const page: Page = await app.firstWindow()
    await page.getByRole('button', { name: 'Open a repo folder' }).click()

    // Three tickets, each started; each Planner asks where the file goes.
    for (const title of TITLES) {
      await page.getByRole('button', { name: 'New ticket' }).click()
      await page.getByLabel('Title').fill(title)
      await page.getByLabel('In your words').fill('Add hello.txt')
      await page.getByRole('button', { name: 'Create' }).click()
      await page.getByRole('button', { name: new RegExp(title) }).click()
      await page.getByLabel('First message (starts the lineup)').fill('Please add hello.txt')
      await page.getByRole('main').getByRole('button', { name: 'Send' }).click()
      await expect(page.locator('[data-event="decision"]')).toContainText('Where should hello.txt go?')
      await page.getByRole('button', { name: /board/ }).click()
    }

    const needsYou = page.getByRole('region', { name: 'Needs you' })
    const waiting = page.getByRole('region', { name: 'Waiting on you' })
    const boardCard = (title: string) => needsYou.getByRole('button', { name: new RegExp(title) })
    const panelCard = (title: string) => waiting.locator('[data-event="waiting-decision"]').filter({ hasText: title })
    for (const title of TITLES) {
      await expect(boardCard(title)).toBeVisible()
      await expect(panelCard(title)).toBeVisible()
    }

    /** Resolved in all three places: gone from Needs you and the panel's group, answered in the thread, heard once. */
    async function expectResolved(title: string, answeredFrom: string): Promise<void> {
      await expect(boardCard(title)).toHaveCount(0)
      await expect(panelCard(title)).toHaveCount(0)
      await page.getByRole('region', { name: 'In progress' }).getByText(title).click()
      await expect(page.locator('[data-event="decision"]')).toContainText('✓ Answered: docs folder')
      await expect(page.getByText('Got your answer, planning it.')).toHaveCount(1)
      await expect(page.getByText(`Decision: Where should hello.txt go? → docs folder (you, from ${answeredFrom})`)).toHaveCount(1)
      await page.getByRole('button', { name: /board/ }).click()
    }

    // 1. The board card.
    await boardCard('Alpha').getByRole('button', { name: 'Answer', exact: true }).click()
    const popover = page.getByRole('dialog')
    await popover.getByRole('radio', { name: /docs folder/ }).check()
    await popover.getByRole('button', { name: 'Answer', exact: true }).click()
    await expectResolved('Alpha', 'the board')

    // 2. The panel's Waiting on you group.
    await panelCard('Beta').getByRole('radio', { name: /docs folder/ }).check()
    await panelCard('Beta').getByRole('button', { name: 'Answer', exact: true }).click()
    await expectResolved('Beta', 'the orchestrator panel')

    // 3. The ticket's thread. The panel's group follows when the ticket is open too.
    await page.getByRole('button', { name: new RegExp('Gamma') }).first().click()
    await page.locator('[data-event="decision"]').getByRole('radio', { name: /docs folder/ }).check()
    await page.locator('[data-event="decision"]').getByRole('button', { name: 'Answer', exact: true }).click()
    await expect(page.locator('[data-event="decision"]')).toContainText('✓ Answered: docs folder')
    await expect(page.getByRole('region', { name: 'Waiting on you' })).toHaveCount(0)
    await page.getByRole('button', { name: /board/ }).click()
    await expectResolved('Gamma', 'the thread')
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})
