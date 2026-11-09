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

function cleanUp(tmp: string | null): void {
  if (!tmp) return
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A temp folder left behind is harmless.
  }
}

async function createReadyTicket(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New ticket' }).click()
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('In your words').fill(title)
  await page.getByLabel('Column').selectOption('ready')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('region', { name: 'Ready' }).getByText(title)).toBeVisible()
}

async function startFromReady(page: Page, title: string): Promise<void> {
  await page.getByRole('region', { name: 'Ready' }).getByText(title).click()
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByText('Ready for review')).toBeVisible()
  await page.getByRole('button', { name: /board$/ }).click()
}

// The app runs with a fake agent and a fake GitHub CLI, in throwaway repositories (a bare one stands in for origin)
// and a temporary MAINBUS_HOME. Two tickets each add migration 0002; the first is merged on "GitHub" (pushed to
// origin's main) and moved to Done, so the second conflicts with main until the Implementer renumbers it.
test('a ticket that clashes with a merged migration shows Conflicts with main, and Update from main clears it', async () => {
  let tmp: string | null = null
  let app: ElectronApplication | null = null
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
    const repo = path.join(tmp, 'repo')
    const origin = path.join(tmp, 'origin.git')
    fs.mkdirSync(path.join(repo, 'migrations'), { recursive: true })
    git(repo, 'init', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'migrations', 'journal.txt'), '0001_init\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'initial')
    git(tmp, 'init', '--bare', '-b', 'main', origin)
    git(repo, 'remote', 'add', 'origin', origin)
    git(repo, 'push', 'origin', 'main')
    const localMain = git(repo, 'rev-parse', 'refs/heads/main').trim()

    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env['ELECTRON_RUN_AS_NODE']
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: {
        ...env,
        MAINBUS_HOME: path.join(tmp, 'home'),
        MAINBUS_RUNTIME: 'fake:e2e/fixtures/update-from-main-by-role.json',
        MAINBUS_TEST_REPO: repo
      }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Add workspace' }).click()

    // Pull requests on, so the update's handoff pushes the branch again.
    await page.getByRole('button', { name: 'Workspace settings' }).click()
    await page.getByRole('switch', { name: /^Open a PR when a ticket reaches Review/ }).check()
    await page.keyboard.press('Escape')

    await createReadyTicket(page, 'Add migration A')
    await startFromReady(page, 'Add migration A')
    await createReadyTicket(page, 'Add migration B')
    await startFromReady(page, 'Add migration B')

    // Mainbus pushed ticket A's branch when it reached Review. GitHub merges it: origin's main moves.
    const branchA = 'mainbus/1-add-migration-a'
    git(repo, 'push', 'origin', `${branchA}:main`)
    await page.getByRole('button', { name: /Add migration A/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to Done' }).click()
    await expect(page.getByRole('region', { name: 'Done' })).toContainText('1')
    await page.mouse.move(700, 2)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await expect(page.getByRole('region', { name: 'Done' })).toHaveAttribute('data-expanded', 'false')

    // B now clashes with main: its card says so, and its view lists the file.
    const review = page.getByRole('region', { name: 'Review' })
    await expect(review.getByText('Conflicts with main')).toBeVisible()
    await review.getByText('Add migration B').click()
    await expect(page.getByText('1 commit behind origin/main.')).toBeVisible()
    await expect(page.getByText('migrations/journal.txt')).toBeVisible()

    await page.getByRole('button', { name: 'Update from main' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Update from main' }).click()

    // The Implementer merges, renumbers 0002_b to 0003_b and hands off: back in Review, with the chip gone.
    await expect(page.getByText('Ready for review')).toBeVisible()
    await expect(page.getByText('Conflicts with main')).toHaveCount(0)
    await expect(page.getByText('Behind main')).toHaveCount(0)
    await expect(page.getByText('Up to date with origin/main.')).toBeVisible()
    await page.getByRole('button', { name: /board$/ }).click()
    await expect(review.getByText('Add migration B')).toBeVisible()
    await expect(review.getByText('Conflicts with main')).toHaveCount(0)

    // The branch has main and the renumbered migration; the user's checkout and local main were never touched.
    const branchB = 'mainbus/2-add-migration-b'
    expect(git(origin, 'show', `refs/heads/${branchB}:migrations/journal.txt`)).toBe('0001_init\n0002_a\n0003_b\n')
    expect(git(origin, 'merge-base', '--is-ancestor', 'refs/heads/main', `refs/heads/${branchB}`)).toBe('')
    expect(git(repo, 'rev-parse', 'refs/heads/main').trim()).toBe(localMain)
    expect(git(repo, 'status', '--porcelain').trim()).toBe('')
  } finally {
    await app?.close().catch(() => {})
    cleanUp(tmp)
  }
})
