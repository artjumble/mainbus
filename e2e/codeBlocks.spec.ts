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
