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

test('a decision put off with Later… > Tomorrow leaves Needs you, and is back in all three places on its date; answering it reaches the agent', async () => {
  let tmp: string | null = null
  let app: ElectronApplication | undefined
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
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
      env: {
        ...env,
        MAINBUS_HOME: home,
        MAINBUS_RUNTIME: 'fake:e2e/fixtures/board-answer-by-role.json',
        MAINBUS_TEST_REPO: repo,
        // The engine's time stands still until the test moves it.
        MAINBUS_FAKE_CLOCK: 'now'
      }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Open a repo folder' }).click()

    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Add hello file')
    await page.getByLabel('In your words').fill('Add hello.txt')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('button', { name: /Add hello file/ }).click()
    await page.getByLabel('First message (starts the lineup)').fill('Please add hello.txt')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()
    await expect(page.locator('[data-event="decision"]')).toContainText('Where should hello.txt go?')
    await page.getByRole('button', { name: /board/ }).click()

    const needsYou = page.getByRole('region', { name: 'Needs you' })
    const inProgress = page.getByRole('region', { name: 'In progress' })
    const waiting = page.getByRole('region', { name: 'Waiting on you' })
    await expect(needsYou.getByText('Add hello file')).toBeVisible()
    await expect(waiting.getByText('Where should hello.txt go?')).toBeVisible()

    // Answer > Later… > Tomorrow, on the board card's popover.
    await needsYou.getByRole('button', { name: 'Answer' }).click()
    const popover = page.getByRole('dialog')
    await popover.getByRole('button', { name: 'Later…' }).click()
    await popover.getByRole('menuitem', { name: 'Tomorrow' }).click()

    // It leaves Needs you; the ticket waits in In progress with the date, and the panel lists it as Deferred.
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const chip = `Waiting on you · until ${tomorrow.toLocaleDateString('en-US', { weekday: 'short' })}`
    await expect(needsYou.getByText('Add hello file')).toHaveCount(0)
    await expect(inProgress.getByText('Add hello file')).toBeVisible()
    await expect(inProgress.getByText(chip)).toBeVisible()
    await expect(waiting).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Deferred \(1\)/ })).toBeVisible()

    // Two days later, in the engine's time: back in Needs you and in the panel's Waiting on you.
    await app.evaluate(async () => {
      const clock = (globalThis as { __mainbusClock?: { advance(ms: number): Promise<void> } }).__mainbusClock
      if (!clock) throw new Error('The fake clock is not on')
      await clock.advance(2 * 24 * 60 * 60 * 1000)
    })
    await expect(needsYou.getByText('Add hello file')).toBeVisible()
    await expect(inProgress.getByText(chip)).toHaveCount(0)
    await expect(waiting.getByText('Where should hello.txt go?')).toBeVisible()
    await expect(page.getByRole('button', { name: /Deferred \(/ })).toHaveCount(0)

    // And in the thread, with its answer controls and no "Deferred until".
    await needsYou.getByText('Add hello file').click()
    const card = page.locator('[data-event="decision"]')
    await expect(card).toContainText('Where should hello.txt go?')
    await expect(card).not.toContainText('Deferred until')
    await card.getByRole('radio', { name: /docs folder/ }).check()
    await card.getByRole('button', { name: 'Answer' }).click()

    // The agent received the answer, once.
    await expect(card).toContainText('✓ Answered: docs folder')
    await expect(page.getByText('Got your answer, planning it.')).toHaveCount(1)
  } finally {
    await app?.close().catch(() => {})
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
