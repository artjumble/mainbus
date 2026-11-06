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

/** A throwaway repo; its folder name is the workspace's name. */
function makeRepo(dir: string): string {
  fs.mkdirSync(dir)
  git(dir, 'init', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'README.md'), '# test repo\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'initial')
  return dir
}

const invoke = (page: Page, command: string, ...args: unknown[]): Promise<{ id: string }> =>
  page.evaluate(
    ([c, a]) =>
      (globalThis as unknown as { mainbus: { invoke: (c: string, ...a: unknown[]) => Promise<{ id: string }> } }).mainbus.invoke(
        c as string,
        ...(a as unknown[])
      ),
    [command, args] as const
  )

const ASK = 'Drop the Run settings part from #1'
const SPEC = 'Build a login form.\nRun settings: a panel of run options.\nTests cover the bad password.'

test('asked to drop part of a Backlog ticket, the orchestrator edits its spec and criteria and appends the message; Undo restores both', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  let app: ElectronApplication | undefined
  try {
    const home = path.join(tmp, 'home')
    const mainbus = makeRepo(path.join(tmp, 'mainbus'))
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env['ELECTRON_RUN_AS_NODE']
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/orchestrator-edit-ticket.json', MAINBUS_TEST_REPO: mainbus }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Add workspace' }).click()
    await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible()
    await invoke(page, 'ticket.create', {
      title: 'Build a login form',
      intent: 'We need a login form',
      spec: SPEC,
      criteria: ['Form renders', 'Run settings shown', 'Bad password rejected'],
      labels: [],
      column: 'backlog'
    })

    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    const box = panel.getByRole('textbox', { name: 'Message the orchestrator' })
    await box.fill(ASK)
    await box.press('Enter')

    // The panel shows the receipt, with the changes on demand.
    const receipt = panel.locator('[data-event="ticket_edited"]')
    await expect(receipt).toContainText('Updated #1: spec, criteria, your words (+1)')
    await receipt.getByRole('button', { name: 'Show changes' }).click()
    await expect(receipt.getByText('- Run settings: a panel of run options.')).toBeVisible()

    // The ticket shows the change and the new entry of the user's words.
    await receipt.getByRole('button', { name: '#1' }).click()
    await expect(page.getByRole('heading', { name: 'Build a login form' })).toBeVisible()
    const spec = page.getByRole('textbox', { name: 'Spec' })
    await expect(spec).toHaveValue('Build a login form.\nTests cover the bad password.')
    const criteria = page.getByRole('region', { name: 'Acceptance criteria' })
    await expect(criteria.getByRole('checkbox')).toHaveCount(2)
    const words = page.getByRole('region', { name: 'Your words' })
    await expect(words.getByText(ASK, { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Activity' }).getByText(/^Edited by the orchestrator at your request: spec, criteria/)).toBeVisible()

    // Undo puts both back and removes the entry.
    await receipt.getByRole('button', { name: 'Undo' }).click()
    await expect(receipt).toContainText('Undone: #1')
    await expect(spec).toHaveValue(SPEC)
    await expect(criteria.getByRole('checkbox')).toHaveCount(3)
    await expect(words.getByText(ASK, { exact: true })).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Activity' }).getByText('Undone', { exact: true })).toBeVisible()
  } finally {
    await app?.close()
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})
