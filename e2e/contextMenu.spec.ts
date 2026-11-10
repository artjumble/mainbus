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

type Item = { label?: string; role?: string; enabled?: boolean; type?: string }

test('a text field has the spelling and edit menu, and a board card keeps its own menu', async () => {
  let tmp: string | null = null
  let app: ElectronApplication | null = null
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init')
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
        MAINBUS_HOME: path.join(tmp, 'home'),
        MAINBUS_RUNTIME: 'fake:e2e/fixtures/ask-then-handoff-by-role.json',
        MAINBUS_TEST_REPO: repo
      }
    })
    const page: Page = await app.firstWindow()
    await page.getByRole('button', { name: 'Add workspace' }).click()
    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Fix the thing')
    await page.getByLabel('In your words').fill('Words')
    await page.getByRole('button', { name: 'Create' }).click()
    const card = page.getByRole('button', { name: /Fix the thing/ })
    await expect(card).toBeVisible()

    // A misspelled word in an editable field (the event is emitted; the test run records the menu instead of showing it).
    const emit = (params: object): Promise<Item[]> =>
      app!.evaluate(
        ({ BrowserWindow }, p) => {
          const hook = (globalThis as unknown as { __mainbusContextMenu: { last: Item[] } }).__mainbusContextMenu
          hook.last = []
          BrowserWindow.getAllWindows()[0]!.webContents.emit('context-menu', {}, p)
          return hook.last
        },
        params
      )
    const flags = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
    const items = await emit({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tea'], selectionText: '', editFlags: flags })
    expect(items.map((i) => i.label ?? i.role)).toEqual([
      'the', 'tea', 'Add to dictionary', undefined, 'undo', 'redo', undefined, 'cut', 'copy', 'paste', 'Paste as plain text', 'selectAll'
    ])
    expect(items.find((i) => i.role === 'redo')?.enabled).toBe(false)
    expect(await emit({ isEditable: false, misspelledWord: '', dictionarySuggestions: [], selectionText: '', editFlags: flags })).toEqual([])

    // The card's own menu still opens, and the text-field handler is not reached by the click.
    await app.evaluate(() => {
      ;(globalThis as unknown as { __mainbusContextMenu: { last: Item[] } }).__mainbusContextMenu.last = []
    })
    await card.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Move to Done' })).toBeVisible()
    const after = await app.evaluate(() => (globalThis as unknown as { __mainbusContextMenu: { last: Item[] } }).__mainbusContextMenu.last)
    expect(after).toEqual([])
  } finally {
    await app?.close().catch(() => undefined)
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }
})
