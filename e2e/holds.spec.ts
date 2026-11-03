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

test('a Ready ticket held until tomorrow is released when the fake clock passes the date, and its chip goes', async () => {
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
        MAINBUS_RUNTIME: 'fake:e2e/fixtures/install-then-handoff.json',
        MAINBUS_TEST_REPO: repo,
        // The engine's time stands still until the test moves it.
        MAINBUS_FAKE_CLOCK: 'now'
      }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Add workspace' }).click()

    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Wait for the API')
    await page.getByLabel('In your words').fill('Build it once the API lands')
    await page.getByLabel('Column').selectOption('ready')
    await page.getByRole('button', { name: 'Create' }).click()
    const ready = page.getByRole('region', { name: 'Ready' })
    await expect(ready.getByText('Wait for the API')).toBeVisible()

    // Hold… > Tomorrow, from the ticket view; the header says when it ends.
    await ready.getByText('Wait for the API').click()
    await page.getByRole('button', { name: 'Hold…' }).click()
    await page.getByRole('menuitem', { name: 'Tomorrow' }).click()
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const chip = `Held until ${tomorrow.toLocaleDateString('en-US', { weekday: 'short' })}`
    await expect(page.getByText(chip)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Unhold' })).toBeVisible()

    // On the board the card carries the chip too.
    await page.getByRole('button', { name: /board$/ }).click()
    await expect(ready.getByText(chip)).toBeVisible()

    // Two days later, in the engine's time: the hold is released and the chip disappears.
    await app.evaluate(async () => {
      const clock = (globalThis as { __mainbusClock?: { advance(ms: number): Promise<void> } }).__mainbusClock
      if (!clock) throw new Error('The fake clock is not on')
      await clock.advance(2 * 24 * 60 * 60 * 1000)
    })
    await expect(ready.getByText(chip)).toHaveCount(0)
    await expect(ready.getByText('Wait for the API')).toBeVisible()
  } finally {
    await app?.close().catch(() => {})
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
