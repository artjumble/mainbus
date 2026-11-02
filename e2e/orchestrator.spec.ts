import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '..')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Mainbus E2E', '-c', 'user.email=e2e@mainbus.test', ...args], {
    cwd,
    windowsHide: true,
    stdio: 'pipe',
    encoding: 'utf8'
  })
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

async function launch(home: string, repo: string, open = true): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/orchestrator.json', MAINBUS_TEST_REPO: repo }
  })
  const page = await app.firstWindow()
  if (open) await page.getByRole('button', { name: 'Open a repo folder' }).click()
  return { app, page }
}

test('the orchestrator panel answers from the board and keeps its thread in the ticket view', async () => {
  const { tmp, home, repo } = makeRepo()
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, repo))
    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    await expect(panel.getByText("Ask me to draft tickets, or about what's happening on the board.")).toBeVisible()

    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Add hello file')
    await page.getByLabel('In your words').fill('Add hello.txt')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('button', { name: /Add hello file/ })).toBeVisible()

    // Ask from the board; Enter sends.
    await panel.getByRole('textbox', { name: 'Message the orchestrator' }).fill('What is on the board?')
    await panel.getByRole('textbox', { name: 'Message the orchestrator' }).press('Enter')
    await expect(panel.getByText('What is on the board?')).toBeVisible()
    await expect(panel.getByText('The board has one ticket.')).toBeVisible()
    await expect(panel.locator('strong', { hasText: 'one' })).toBeVisible()
    await expect(panel.getByRole('button', { name: /Looked at the board/ })).toBeVisible()
    await expect(panel.getByText('Thought for 1s')).toBeVisible()
    await expect(panel.getByRole('textbox', { name: 'Message the orchestrator' })).toHaveValue('')

    // Open the ticket: the panel and its thread are still there.
    await page.getByRole('button', { name: /Add hello file/ }).click()
    await expect(page.getByRole('heading', { name: 'Add hello file' })).toBeVisible()
    await expect(panel.getByText('The board has one ticket.')).toBeVisible()
    await expect(panel.getByText('What is on the board?')).toBeVisible()

    // Back on the board, at a narrow window: the board scrolls in its own area, and the panel never covers it.
    await page.getByRole('main').getByRole('button', { name: /board/ }).click()
    await expect(page.getByText('Backlog')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(900, 700))
    const html = page.locator('html')
    await expect.poll(() => html.evaluate((el) => el.clientWidth)).toBeLessThan(1000)
    const aside = (await panel.boundingBox())!
    // The columns' own scroll area: the nearest ancestor of a column that scrolls sideways.
    const board = await page.getByRole('region', { name: 'Done' }).evaluate((column) => {
      const view = column.ownerDocument.defaultView!
      let el = column.parentElement
      while (el && view.getComputedStyle(el).overflowX !== 'auto') el = el.parentElement
      if (!el) throw new Error('no scroll area')
      return { right: el.getBoundingClientRect().right, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }
    })
    expect(board.right).toBeLessThanOrEqual(aside.x + 1)
    expect(board.scrollWidth).toBeGreaterThan(board.clientWidth)
    // The page itself doesn't scroll sideways: only the board does.
    expect(await html.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await expect(panel.getByText('The board has one ticket.')).toBeVisible()

    // Collapse to the strip; a restart remembers it.
    await panel.getByRole('button', { name: 'Collapse orchestrator panel' }).click()
    await expect(panel.getByRole('button', { name: 'Open orchestrator (0 need you)' })).toBeVisible()
    await app.close()
    app = undefined
    ;({ app, page } = await launch(home, repo, false))
    const strip = page.getByRole('complementary', { name: 'Orchestrator' }).getByRole('button', { name: /^Open orchestrator/ })
    await expect(strip).toBeVisible()
    await strip.click()
    await expect(page.getByRole('complementary', { name: 'Orchestrator' }).getByText('The board has one ticket.')).toBeVisible()
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
