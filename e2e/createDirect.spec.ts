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

// The second workspace is opened, and the focus set, through the preload bridge, as multiWorkspace.spec does.
const invoke = (page: Page, command: string, ...args: unknown[]): Promise<{ id: string }> =>
  page.evaluate(
    ([c, a]) =>
      (globalThis as unknown as { mainbus: { invoke: (c: string, ...a: unknown[]) => Promise<{ id: string }> } }).mainbus.invoke(
        c as string,
        ...(a as unknown[])
      ),
    [command, args] as const
  )

const ASK = 'Please add a ticket for a contact form.'

test('asked for a ticket without a workspace, the orchestrator asks which one, then creates it in that Backlog with both messages as its intent', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  let app: ElectronApplication | undefined
  try {
    const home = path.join(tmp, 'home')
    const mainbus = makeRepo(path.join(tmp, 'mainbus'))
    const website = makeRepo(path.join(tmp, 'website'))
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env['ELECTRON_RUN_AS_NODE']
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/orchestrator-create-direct.json', MAINBUS_TEST_REPO: mainbus }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Add workspace' }).click()
    await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible()
    const a = await invoke(page, 'workspace.get')
    const b = await invoke(page, 'workspace.open', website)
    // The focused workspace is not the answer: it is mainbus, and the user wants website.
    await invoke(page, 'workspace.focus', a.id)

    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    const box = panel.getByRole('textbox', { name: 'Message the orchestrator' })

    // 1. The user asks for a ticket without naming a workspace.
    await box.fill(ASK)
    await box.press('Enter')
    // 2. The orchestrator asks which one; the user answers.
    await expect(panel.getByText('Which workspace should these go in: mainbus or website?')).toBeVisible()
    await box.fill('website')
    await box.press('Enter')

    // 4. The panel shows the receipt, with a link to the ticket.
    const receipt = panel.locator('[data-event="tickets_created"]')
    await expect(receipt).toHaveText("Created #1 in website's Backlog")
    await expect(panel.getByRole('group', { name: /^Proposal:/ })).toHaveCount(0)

    // Nothing went into the focused workspace.
    const backlog = page.getByRole('region', { name: 'Backlog' })
    await expect(backlog.getByRole('button', { name: /Add a contact form/ })).toHaveCount(0)

    // 3. The link focuses website and opens the ticket: its intent is both of the user's messages.
    await receipt.getByRole('button', { name: '#1' }).click()
    await expect(page.getByRole('heading', { name: 'Add a contact form' })).toBeVisible()
    expect((await invoke(page, 'workspace.get')).id).toBe(b.id)
    const words = page.getByRole('region', { name: 'Your words' })
    await expect(words.getByText(ASK, { exact: true })).toBeVisible()
    await expect(words.getByText('website', { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Activity' }).getByText('Created by the orchestrator at your request')).toBeVisible()

    // It is in website's Backlog.
    await page.getByRole('button', { name: /board/ }).click()
    await expect(backlog.getByRole('button', { name: /Add a contact form/ })).toBeVisible()
  } finally {
    await app?.close()
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})
