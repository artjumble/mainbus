import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { addWorkspace } from './addWorkspace'

const root = path.resolve(import.meta.dirname, '..')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Mainbus E2E', '-c', 'user.email=e2e@mainbus.test', ...args], {
    cwd,
    windowsHide: true,
    stdio: 'pipe'
  })
}

/**
 * A Done ticket is archived from its view, found again through the Archive view, the board search (`#1`) and a blocker
 * link, and restored to Done. FakeRuntime, a temporary MAINBUS_HOME and a throwaway repo.
 */
test('archive a Done ticket, find it three ways, and restore it to Done', async () => {
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
      env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/handoff.json', MAINBUS_TEST_REPO: repo }
    })
    const page: Page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 960))
    await addWorkspace(page)
    const column = (name: string) => page.getByRole('region', { name, exact: true })
    // Done is a strip until focus is in it; the cards and the Archive button are then reachable.
    const openDone = async () => column('Done').focus()
    const backToBoard = () => page.getByRole('button', { name: /board$/ }).click()
    const ticketHeading = (title: string) => page.getByRole('heading', { name: title, level: 2 })

    // #1 goes to Done; #2 is blocked by it.
    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Old job')
    await page.getByLabel('In your words').fill('Old job')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('button', { name: /Old job/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to Done' }).click()
    await expect(column('Done').getByText('Old job')).toHaveCount(1)

    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Second job')
    await page.getByLabel('In your words').fill('Second job')
    await page.getByRole('combobox', { name: /Blocked by/ }).click()
    await page.getByRole('option', { name: '#1 Old job (Done)' }).click()
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(column('Backlog').getByText('Second job')).toBeVisible()

    // Archive #1 from its own view: it leaves the board, and its view says so.
    await openDone()
    await column('Done').getByRole('button', { name: /Old job/ }).click()
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(page.getByText('Archived', { exact: true })).toBeVisible()
    await expect(page.getByText('This ticket is archived. Restore puts it back in Done.')).toBeVisible()
    await backToBoard()
    await expect(column('Done').getByText('Old job')).toHaveCount(0)

    // Found through the Archive view, under a month heading.
    await openDone()
    await page.getByRole('button', { name: 'Archive (1)' }).click()
    await expect(page.getByRole('heading', { name: 'Archive', level: 2 })).toBeVisible()
    await expect(page.getByRole('heading', { level: 3 })).toHaveCount(1)
    await expect(page.getByRole('button', { name: '#1 Old job', exact: true })).toBeVisible()
    await backToBoard()

    // Found through the board search: #1 offers to open it, and Enter does.
    const search = page.getByRole('textbox', { name: 'Search tickets' })
    await search.fill('#1')
    await expect(page.getByText('#1 Old job is archived.')).toBeVisible()
    await search.press('Enter')
    await expect(ticketHeading('Old job')).toBeVisible()
    await backToBoard()
    await search.fill('')

    // Found through a blocker link on #2.
    await page.getByRole('button', { name: /Second job/ }).click()
    await page.getByRole('list', { name: 'Blockers' }).getByRole('button', { name: '#1 Old job', exact: true }).click()
    await expect(ticketHeading('Old job')).toBeVisible()
    await expect(page.getByText('Archived', { exact: true })).toBeVisible()
    await backToBoard()

    // Restore it from the Archive view with the bulk control: back in Done.
    await openDone()
    await page.getByRole('button', { name: 'Archive (1)' }).click()
    await page.getByRole('checkbox', { name: 'Select #1 Old job' }).check()
    await page.getByRole('button', { name: 'Restore selected (1)' }).click()
    await expect(page.getByText('Nothing is archived yet.')).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Search the archive' })).toBeFocused()
    await backToBoard()
    await expect(column('Done').getByText('Old job')).toHaveCount(1)
    await expect(page.getByRole('button', { name: /^Archive \(/ })).toHaveCount(0)
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
