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

/** A repo with main pushed to a bare origin, and a local-only feature/x with one more commit, checked out. */
function makeRepos(): { tmp: string; home: string; repo: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  const repo = path.join(tmp, 'repo')
  const origin = path.join(tmp, 'origin.git')
  fs.mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')
  git(tmp, 'init', '--bare', '-b', 'main', origin)
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-u', 'origin', 'main')
  git(repo, 'checkout', '-b', 'feature/x')
  fs.writeFileSync(path.join(repo, 'feature.txt'), 'only on feature/x\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'feature work')
  return { tmp, home: path.join(tmp, 'home'), repo }
}

async function launch(home: string, repo: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/handoff.json', MAINBUS_TEST_REPO: repo }
  })
  return { app, page: await app.firstWindow() }
}

test('adding on a feature branch defaults the base to main; changing it in settings is what new tickets branch from', async () => {
  let tmp: string | null = null
  let app: ElectronApplication | null = null
  try {
    const made = makeRepos()
    tmp = made.tmp
    let page: Page
    ;({ app, page } = await launch(made.home, made.repo))

    await page.getByRole('button', { name: 'Add workspace' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText("Base branch: main (you're on feature/x)")).toBeVisible()
    await dialog.getByRole('button', { name: 'Add workspace' }).click()
    await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible()

    await page.getByRole('button', { name: 'Workspace settings' }).click()
    const select = page.getByRole('combobox', { name: /^Base branch/ })
    await expect(select).toHaveValue('main · on origin')

    await select.click()
    await page.getByRole('option', { name: 'feature/x' }).click()
    await page.getByRole('button', { name: 'Save base branch' }).click()
    const warning = "Pull requests will fail: feature/x isn't on origin"
    await expect(page.getByText(warning)).toHaveCount(2)
    await page.keyboard.press('Escape')
    await expect(page.getByText(warning)).toBeVisible()

    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Branch from feature')
    await page.getByLabel('In your words').fill('Branch from feature')
    await page.getByLabel('Column').selectOption('ready')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('region', { name: 'Ready' }).getByText('Branch from feature').click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByText('Ready for review')).toBeVisible()

    const branch = git(made.repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/mainbus/').trim()
    expect(branch).toMatch(/^mainbus\/1-/)
    git(made.repo, 'merge-base', '--is-ancestor', 'feature/x', branch)
  } finally {
    await app?.close().catch(() => {})
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // A temp folder left behind is harmless.
      }
    }
  }
})
