import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '..')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Mainbus E2E', '-c', 'user.email=e2e@mainbus.test', ...args], {
    cwd,
    windowsHide: true,
    stdio: 'pipe',
    encoding: 'utf8'
  })
}

function cleanUp(tmp: string | null): void {
  if (!tmp) return
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A temp folder left behind is harmless.
  }
}

// The app runs with a fake agent, in a throwaway repository with no remote and a temporary MAINBUS_HOME. A ticket
// adds hello.txt and reaches Review; Merge… fast-forwards the user's checkout to the ticket's branch and moves it to Done.
test('Merge… on a ticket in Review of a repo with no remote puts its files in the checkout and moves it to Done', async () => {
  let tmp: string | null = null
  let app: ElectronApplication | null = null
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo, { recursive: true })
    git(repo, 'init', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'readme.txt'), 'hi\n')
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
        MAINBUS_RUNTIME: 'fake:e2e/fixtures/merge-by-role.json',
        MAINBUS_TEST_REPO: repo
      }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Add workspace' }).click()

    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Add hello')
    await page.getByLabel('In your words').fill('Add hello.txt')
    await page.getByLabel('Column').selectOption('ready')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('region', { name: 'Ready' }).getByText('Add hello').click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByText('Ready for review')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Merge…' })).toBeVisible()

    // Nothing is in the user's checkout until the merge.
    expect(fs.existsSync(path.join(repo, 'hello.txt'))).toBe(false)

    await page.getByRole('button', { name: 'Merge…' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(/^Fast-forwards main to mainbus\/1-add-hello \(1 commit\) in your checkout/)).toBeVisible()
    await expect(dialog.getByRole('checkbox', { name: /Move to Done afterwards/ })).toBeChecked()
    await dialog.getByRole('button', { name: 'Merge', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    // The checkout is at the branch's commit, with the file, and still clean.
    const branchCommit = git(repo, 'rev-parse', 'refs/heads/mainbus/1-add-hello').trim()
    expect(git(repo, 'rev-parse', 'refs/heads/main').trim()).toBe(branchCommit)
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(branchCommit)
    expect(fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8')).toBe('hello from the ticket\n')
    expect(git(repo, 'status', '--porcelain').trim()).toBe('')

    // The ticket is Done.
    await page.getByRole('button', { name: /board$/ }).click()
    await expect(page.getByRole('region', { name: 'Done' })).toContainText('1')
    await expect(page.getByRole('region', { name: 'Review' }).getByText('Add hello')).toHaveCount(0)
  } finally {
    await app?.close().catch(() => {})
    cleanUp(tmp)
  }
})
