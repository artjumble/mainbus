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

test('a message that answers the agent\'s question settles the card everywhere and the agent hears it once', async () => {
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
    await page.getByRole('button', { name: 'Add workspace' }).click()

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
    const boardCard = needsYou.locator('.mantine-Paper-root').filter({ has: page.getByRole('button', { name: /Alpha/ }) })
    const panelCard = waiting.locator('[data-event="waiting-decision"]').filter({ hasText: 'Alpha' })
    await expect(boardCard).toBeVisible()
    await expect(panelCard).toBeVisible()

    // Answer in the ticket's message box instead of on any card.
    await boardCard.getByRole('button', { name: /Alpha/ }).click()
    await page.getByPlaceholder('Steer it, answer a question, add context').fill('Put it in docs, I merged the other branch')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()

    await expect(page.locator('[data-event="decision"]')).toContainText('✓ Answered in a message')
    await expect(page.getByText('Got your answer, planning it.')).toHaveCount(1)
    await expect(page.getByText('answered in a message (you)')).toHaveCount(1)
    await page.getByRole('button', { name: /board/ }).click()
    await expect(boardCard).toHaveCount(0)
    await expect(panelCard).toHaveCount(0)
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})
