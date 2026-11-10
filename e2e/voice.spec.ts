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
  execFileSync('git', ['-c', 'user.name=Mainbus E2E', '-c', 'user.email=e2e@mainbus.test', ...args], { cwd, windowsHide: true, stdio: 'pipe' })
}

/** A temp folder with a throwaway repo and a Mainbus home of its own. */
function makeRepo(): { tmp: string; home: string; repo: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  const repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')
  return { tmp, home: path.join(tmp, 'home'), repo }
}

/** Launches the app with the fake runtime, a fake transcriber and Chromium's fake microphone: no real microphone, no model download. */
async function launch(home: string, repo: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: {
      ...env,
      MAINBUS_HOME: home,
      MAINBUS_RUNTIME: 'fake:e2e/fixtures/orchestrator.json',
      MAINBUS_TEST_REPO: repo,
      MAINBUS_TEST_VOICE: 'fake'
    }
  })
  const page = await app.firstWindow()
  await page.getByRole('button', { name: 'Add workspace' }).click()
  return { app, page }
}

test('dictating into the orchestrator box puts the text in the box and sends nothing; Esc cancels', async () => {
  const { tmp, home, repo } = makeRepo()
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, repo))
    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    const box = panel.getByRole('textbox', { name: 'Message the orchestrator' })
    const mic = panel.getByRole('button', { name: /^Dictate/ })
    await expect(mic).toHaveAttribute('aria-pressed', 'false')

    await box.fill('Hello')
    await box.press('Control+Shift+Space')
    await expect(mic).toHaveAttribute('aria-pressed', 'true')
    await expect(panel.getByText(/^\d+:\d\d$/)).toBeVisible()
    // Let the fake microphone's tone run a moment, so the recording is not silence.
    await page.waitForTimeout(600)
    await box.press('Enter')
    await expect(box).toHaveValue('Hello This was dictated.')
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
    // Nothing was sent: the thread has no message from the user.
    await expect(panel.locator(':not(textarea):text("Hello This was dictated.")')).toHaveCount(0)
    await expect(panel.getByText("Ask me to draft tickets, or about what's happening on the board.")).toBeVisible()

    // Esc cancels and leaves the text as it was.
    await box.press('Control+Shift+Space')
    await expect(mic).toHaveAttribute('aria-pressed', 'true')
    await page.waitForTimeout(300)
    await box.press('Escape')
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
    await expect(box).toHaveValue('Hello This was dictated.')
    await expect(panel.locator(':not(textarea):text("Hello This was dictated.")')).toHaveCount(0)
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('New ticket has the mic in "In your words" and "Spec", Esc while recording keeps the dialog open, and there is nothing to fix for axe', async () => {
  const { tmp, home, repo } = makeRepo()
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, repo))
    await page.getByRole('button', { name: 'New ticket' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'Dictate' }).first()).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Dictate' }).nth(1)).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Dictate' })).toHaveCount(2)

    const words = dialog.getByRole('textbox', { name: 'In your words' })
    await words.press('Control+Shift+Space')
    await expect(dialog.getByRole('button', { name: 'Dictate' }).first()).toHaveAttribute('aria-pressed', 'true')
    await page.waitForTimeout(300)
    await words.press('Escape')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Dictate' }).first()).toHaveAttribute('aria-pressed', 'false')

    await words.press('Control+Shift+Space')
    await page.waitForTimeout(600)
    await words.press('Enter')
    await expect(words).toHaveValue('This was dictated.')

    await page.evaluate(axeSource)
    const violations = await page.evaluate(async () => {
      const results = await (window as unknown as { axe: { run: (c: Document) => Promise<{ violations: { id: string; help: string }[] }> } }).axe.run(document)
      return results.violations.map((v) => `${v.id}: ${v.help}`)
    })
    expect(violations, 'axe violations with the mic visible').toEqual([])
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
