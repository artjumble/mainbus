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

/**
 * A ticket blocked by another is skipped by unattended mode while its blocker isn't Done, and started once the blocker is
 * moved to Done. Every role hands off at once, in a temporary home and a throwaway repo.
 */
test('unattended mode skips a ticket blocked by another, and starts it once the blocker is moved to Done', async () => {
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
      env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/handoff.json', MAINBUS_TEST_REPO: repo }
    })
    const page: Page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 960))
    await page.getByRole('button', { name: 'Add workspace' }).click()
    const column = (name: string) => page.getByRole('region', { name, exact: true })

    // #1 is started by hand and waits in Review.
    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('First job')
    await page.getByLabel('In your words').fill('First job')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('button', { name: /First job/ }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByText('Ready for review', { exact: true })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: /board/ }).click()
    await expect(column('Review').getByText('First job')).toBeVisible()

    // #2 is created in Ready, blocked by #1.
    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Second job')
    await page.getByLabel('In your words').fill('Second job')
    await page.getByLabel('Column').selectOption('ready')
    await page.getByRole('combobox', { name: /Blocked by/ }).click()
    await page.getByRole('option', { name: '#1 First job' }).click()
    await page.getByRole('button', { name: 'Create' }).click()
    const second = column('Ready').getByText('Second job')
    await expect(second).toBeVisible()
    await expect(column('Ready').getByText('Blocked by #1')).toBeVisible()

    // Unattended mode leaves it in Ready.
    await page.getByRole('switch', { name: 'Unattended' }).check()
    await expect(page.getByTestId('unattended-status')).toHaveText(/Waiting for Ready tickets/)
    await page.waitForTimeout(500)
    await expect(second).toBeVisible()

    // #1 moves to Done by keyboard; #2 starts by itself, lands in Review, and the chip is gone.
    const announced = page.locator('[id^="DndLiveRegion"]')
    await column('Review').getByRole('button', { name: /^Move ticket #1/ }).focus()
    await page.keyboard.press('Space')
    await expect(announced).toContainText('Picked up ticket #1 First job')
    // dnd-kit starts listening for the next key a moment after it announces the pick-up.
    await page.waitForTimeout(200)
    await page.keyboard.press('ArrowRight')
    await expect(announced).toContainText('ticket #1 First job is over Done')
    await page.keyboard.press('Space')
    await expect(announced).toContainText('ticket #1 First job was dropped on Done')

    await expect(column('Review').getByText('Second job')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('Blocked by #1')).toHaveCount(0)
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
