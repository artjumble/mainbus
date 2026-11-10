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

function makeRepo(dir: string): string {
  fs.mkdirSync(dir)
  git(dir, 'init', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'README.md'), '# test repo\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'initial')
  return dir
}

test('the rail adds a second workspace, switches between them, and counts a decision in the one not on screen', async () => {
  let tmp: string | null = null
  let app: ElectronApplication | undefined
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
    const home = path.join(tmp, 'home')
    const repoA = makeRepo(path.join(tmp, 'alpha-repo'))
    const repoB = makeRepo(path.join(tmp, 'bravo-repo'))

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
        // The folder picker answers these in order: first the first-run button, then + Add workspace.
        MAINBUS_TEST_REPO: [repoA, repoB].join(path.delimiter),
        MAINBUS_FAKE_CLOCK: 'now'
      }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Add workspace' }).click()

    const rail = page.getByRole('navigation', { name: 'Workspaces' })
    const entryA = rail.getByRole('button', { name: /^alpha-repo/ })
    const entryB = rail.getByRole('button', { name: /^bravo-repo/ })
    await expect(entryA).toHaveAttribute('aria-current', 'true')

    // + Add workspace explains trust first; the folder is added and focused.
    await rail.getByRole('button', { name: 'Add workspace' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('treats the folder you pick as')
    await expect(dialog).toContainText('own copy of the project')
    await dialog.getByRole('button', { name: 'Choose folder…' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(entryB).toHaveAttribute('aria-current', 'true')
    await expect(page.getByRole('heading', { level: 2, name: 'bravo-repo' })).toBeVisible()
    await expect(page.getByText(repoB, { exact: true })).toBeVisible()

    // A ticket in alpha-repo asks a question.
    await entryA.click()
    await expect(page.getByRole('heading', { level: 2, name: 'alpha-repo' })).toBeVisible()
    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Add hello file')
    await page.getByLabel('In your words').fill('Add hello.txt')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('button', { name: /Add hello file/ }).click()
    await page.getByLabel('First message (starts the lineup)').fill('Please add hello.txt')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()
    await expect(page.locator('[data-event="decision"]')).toContainText('Where should hello.txt go?')
    await page.getByRole('button', { name: /board/ }).click()

    // Its badge counts it; answering with Later… > Tomorrow takes it away.
    await expect(entryA.getByLabel('1 need you')).toBeVisible()
    const needsYou = page.getByRole('region', { name: 'Needs you' })
    await needsYou.getByRole('button', { name: 'Answer' }).click()
    const popover = page.getByRole('dialog')
    await popover.getByRole('button', { name: 'Later…' }).click()
    await popover.getByRole('menuitem', { name: 'Tomorrow' }).click()
    await expect(entryA.getByLabel(/need you/)).toHaveCount(0)

    // Look at the other workspace, with the orchestrator collapsed to its strip.
    await entryB.click()
    await expect(page.getByRole('heading', { level: 2, name: 'bravo-repo' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Add hello file/ })).toHaveCount(0)
    const collapse = page.getByRole('button', { name: 'Collapse orchestrator panel' })
    if (await collapse.isVisible()) await collapse.click()
    await expect(page.getByRole('button', { name: 'Open orchestrator (0 need you)' })).toBeVisible()

    // Two days later, in the engine's time, the decision is back: on alpha-repo's badge and in the strip's total.
    await app.evaluate(async () => {
      const clock = (globalThis as { __mainbusClock?: { advance(ms: number): Promise<void> } }).__mainbusClock
      if (!clock) throw new Error('The fake clock is not on')
      await clock.advance(2 * 24 * 60 * 60 * 1000)
    })
    await expect(entryA.getByLabel('1 need you')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open orchestrator (1 need you)' })).toBeVisible()
    await expect(entryB).toHaveAttribute('aria-current', 'true')
  } finally {
    await app?.close().catch(() => {})
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // A temp folder left behind is harmless.
      }
    }
  }
})
