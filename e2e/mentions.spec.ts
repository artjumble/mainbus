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

test('picking @hunter from the list sends its identity, and the orchestrator creates the ticket in hunter', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  let app: ElectronApplication | undefined
  try {
    const home = path.join(tmp, 'home')
    const mainbus = makeRepo(path.join(tmp, 'mainbus'))
    const hunter = makeRepo(path.join(tmp, 'hunter'))
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env['ELECTRON_RUN_AS_NODE']
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/orchestrator-mentions.json', MAINBUS_TEST_REPO: mainbus }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Add workspace' }).click()
    await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible()
    const a = await invoke(page, 'workspace.get')
    await invoke(page, 'workspace.open', hunter)
    // mainbus is the focused one; the user means hunter.
    await invoke(page, 'workspace.focus', a.id)

    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    const box = panel.getByRole('textbox', { name: 'Message the orchestrator' })

    await box.pressSequentially('create a ticket in @hu')
    const option = page.getByRole('option', { name: /hunter/ })
    await expect(option).toBeVisible()
    await box.press('Enter')
    await expect(box).toHaveValue('create a ticket in @hunter ')
    await box.pressSequentially('for X')
    await box.press('Enter')

    const receipt = panel.locator('[data-event="tickets_created"]')
    await expect(receipt).toHaveText("Created #1 in hunter's Backlog")
    await expect(panel.locator('[data-event="user_message"] [data-mention]')).toHaveText('hunter')
  } finally {
    await app?.close()
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})

for (const theme of ['light', 'dark'] as const)
  test(`the @ list is a sized dropdown above the caret's line and inside the panel (${theme})`, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
    let app: ElectronApplication | undefined
    try {
      const home = path.join(tmp, 'home')
      const mainbus = makeRepo(path.join(tmp, 'mainbus'))
      const hunter = makeRepo(path.join(tmp, 'hunter'))
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env['ELECTRON_RUN_AS_NODE']
      app = await electron.launch({
        args: ['.'],
        cwd: root,
        env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/orchestrator-mentions.json', MAINBUS_TEST_REPO: mainbus }
      })
      const page = await app.firstWindow()
      await page.getByRole('button', { name: 'Add workspace' }).click()
      await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible()
      await invoke(page, 'workspace.open', hunter)
      await invoke(page, 'settings.setTheme', theme)
      await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', theme)

      const panel = page.getByRole('complementary', { name: 'Orchestrator' })
      const box = panel.getByRole('textbox', { name: 'Message the orchestrator' })
      await box.pressSequentially('line one\nline two\nline three')
      await box.pressSequentially(' @')
      const list = page.getByRole('listbox')
      await expect(list.getByRole('option')).toHaveCount(2)

      const dropdown = await list.boundingBox()
      const field = await box.boundingBox()
      const bounds = await panel.boundingBox()
      expect(dropdown!.width).toBeGreaterThanOrEqual(200)
      for (const option of await list.getByRole('option').all()) {
        const o = (await option.boundingBox())!
        expect(o.x).toBeGreaterThanOrEqual(dropdown!.x)
        expect(o.x + o.width).toBeLessThanOrEqual(dropdown!.x + dropdown!.width + 1)
      }
      // Above the caret line (the last line of text, which sits in the bottom 40 px of the box), inside the panel and the window.
      expect(dropdown!.y + dropdown!.height).toBeLessThanOrEqual(field!.y + field!.height - 40)
      expect(dropdown!.x).toBeGreaterThanOrEqual(bounds!.x - 1)
      expect(dropdown!.x + dropdown!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1)
      expect(dropdown!.y).toBeGreaterThanOrEqual(0)
      const shadow = await page.locator('.mantine-Combobox-dropdown').evaluate((e) => getComputedStyle(e).boxShadow)
      expect(shadow).not.toBe('none')
    } finally {
      await app?.close()
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // A temp folder left behind is harmless.
      }
    }
  })
