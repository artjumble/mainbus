/// <reference lib="dom" />
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '..')
const axeSource = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Mainbus E2E', '-c', 'user.email=e2e@mainbus.test', ...args], {
    cwd,
    windowsHide: true,
    stdio: 'pipe'
  })
}

/** Runs axe over the page with every rule on, colour contrast included. */
async function expectNoAxeViolations(page: Page, what: string): Promise<void> {
  await page.evaluate(axeSource)
  const violations = await page.evaluate(async () => {
    const results = await (window as unknown as { axe: { run: (c: Document) => Promise<{ violations: { id: string; help: string }[] }> } }).axe.run(document)
    return results.violations.map((v) => `${v.id}: ${v.help}`)
  })
  expect(violations, `axe violations on ${what}`).toEqual([])
}

test('a permission for a heredoc command shows as a code block, and an orchestrator reply with a fence is highlighted', async () => {
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
      env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/code-blocks-by-role.json', MAINBUS_TEST_REPO: repo }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Add workspace' }).click()

    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Alpha')
    await page.getByLabel('In your words').fill('Add a limiter')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('button', { name: /Alpha/ }).click()
    await page.getByLabel('First message (starts the lineup)').fill('Please add the limiter')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()
    await expect(page.locator('[data-event="permission"]')).toContainText('Planner wants to run')
    await page.getByRole('button', { name: /board/ }).click()

    // The panel's card: the command is a code block with Copy, capped with Show all, and the reason below.
    const waiting = page.getByRole('region', { name: 'Waiting on you' })
    const card = waiting.locator('[data-event="waiting-decision"]')
    await expect(card).toHaveCount(1)
    await expect(card.getByText('Planner wants to run')).toBeVisible()
    const block = card.locator('pre code')
    await expect(block).toContainText("cat > src/limiter.ts <<'EOF'")
    await expect(block).toContainText('export const DEFAULT_MAX = 5')
    await expect(block.locator('[class*="hljs-"]').first()).toBeVisible()
    await expect(card.getByRole('button', { name: 'Copy command' })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Show all' })).toBeVisible()
    await expect(card.getByText('Writes a file with a heredoc')).toBeVisible()
    // The command is capped at 6 lines in the panel, so the answer buttons are in view without scrolling the group.
    await expect(card.getByRole('button', { name: 'Allow once' })).toBeInViewport({ ratio: 1 })
    await expectNoAxeViolations(page, 'the permission card with a code block')
    await card.getByRole('button', { name: 'Show all' }).click()
    await expect(card.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')

    // An orchestrator reply with a fenced block is highlighted, with its language and Copy.
    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    const box = panel.getByRole('textbox', { name: 'Message the orchestrator' })
    await box.fill('Show me the check.')
    await box.press('Enter')
    await expect(panel.getByText('Here is the check:')).toBeVisible()
    await expect(panel.getByText('const limit', { exact: false }).locator('.hljs-keyword').first()).toBeVisible()
    await expect(panel.getByText('ts', { exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Copy code' })).toBeVisible()
    await expect(panel.locator('code', { hasText: 'npm test' })).toBeVisible()
    await expectNoAxeViolations(page, 'the orchestrator reply with code')
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})

test('answering two permissions in the panel, the third card arrives with its buttons in view; a new one after keyboard scrolling shows a pill', async () => {
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
      env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/three-permissions.json', MAINBUS_TEST_REPO: repo }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Add workspace' }).click()

    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Alpha')
    await page.getByLabel('In your words').fill('Add a limiter')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('button', { name: /Alpha/ }).click()
    await page.getByLabel('First message (starts the lineup)').fill('Please add the limiter')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()
    await expect(page.locator('[data-event="permission"]')).toContainText('Planner wants to run')
    await page.getByRole('button', { name: /board/ }).click()

    const waiting = page.getByRole('region', { name: 'Waiting on you' })
    const cards = waiting.locator('[data-event="waiting-decision"]')
    await expect(cards).toHaveCount(1)
    await cards.first().getByRole('button', { name: 'Allow once' }).click()
    await expect(cards.first().getByText('Reads recent history')).toBeVisible()
    await cards.first().getByRole('button', { name: 'Allow once' }).click()

    // The third, long card arrives with its answer buttons in view, with no scrolling.
    const third = cards.filter({ hasText: 'Writes a file with a heredoc' })
    await expect(third).toHaveCount(1)
    await expect(third.getByRole('button', { name: 'Allow once' })).toBeInViewport({ ratio: 1 })

    // The user scrolls by keyboard, then answers; the fourth card arrives while they are reading, so a pill offers it.
    await third.getByRole('button', { name: 'Allow once' }).focus()
    await page.keyboard.press('PageDown')
    await third.getByRole('button', { name: 'Allow once' }).click()
    await expect(waiting.getByText('Runs the tests')).toBeAttached()
    await expect(page.getByRole('button', { name: /New: #\d+ is waiting on you/ })).toBeVisible()
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})
