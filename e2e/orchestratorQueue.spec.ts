import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { addWorkspace } from './addWorkspace'

const root = path.resolve(import.meta.dirname, '..')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Mainbus E2E', '-c', 'user.email=e2e@mainbus.test', ...args], { cwd, windowsHide: true, stdio: 'pipe' })
}

test('messages sent while the orchestrator works are queued, then delivered in order', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  const repo = path.join(tmp, 'repo')
  const home = path.join(tmp, 'home')
  fs.mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')

  let app: ElectronApplication | undefined
  try {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env['ELECTRON_RUN_AS_NODE']
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/orchestrator-queue.json', MAINBUS_TEST_REPO: repo }
    })
    const page = await app.firstWindow()
    await addWorkspace(page)

    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    const box = panel.getByRole('textbox', { name: 'Message the orchestrator' })
    await box.fill('First')
    await box.press('Enter')
    await expect(panel.getByText('Working…')).toBeVisible()
    await expect(panel.getByText('Working on the first.')).toBeVisible()

    // The first turn is held open: the next two are queued, in order, and not in the thread yet.
    await box.fill('Second')
    await box.press('Enter')
    await box.fill('Third')
    await box.press('Enter')
    const queue = panel.getByRole('list', { name: 'Queued messages' })
    const items = queue.getByRole('listitem')
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toContainText('Queued · 1st')
    await expect(items.nth(0)).toContainText('Second')
    await expect(items.nth(1)).toContainText('Queued · 2nd')
    await expect(items.nth(1)).toContainText('Third')
    await expect(panel.locator('[data-event="user_message"]')).toHaveCount(1)
    await expect(box).toHaveValue('')

    // Let the first turn end: the queued messages become turns of their own, one after the other.
    fs.writeFileSync(path.join(home, 'orchestrator', 'release-first'), 'go')
    await expect(panel.getByText('Answered the third.')).toBeVisible()
    await expect(queue).toHaveCount(0)
    await expect(panel.locator('[data-event="user_message"]')).toHaveText(['First', 'Second', 'Third'])
    await expect(panel.getByText('Answered the second.')).toBeVisible()
  } finally {
    await app?.close().catch(() => {})
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
