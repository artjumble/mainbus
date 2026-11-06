import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '..')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe', encoding: 'utf8' })
}

/**
 * A temp folder with a throwaway repo, a bare repository standing in for origin, and a Mainbus home of its own. The
 * repo has its own identity, which the report's commit is made with.
 */
function makeRepos(): { tmp: string; home: string; repo: string; origin: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  const repo = path.join(tmp, 'repo')
  const origin = path.join(tmp, 'origin.git')
  fs.mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Mainbus E2E')
  git(repo, 'config', 'user.email', 'e2e@mainbus.test')
  fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')
  git(tmp, 'init', '--bare', '-b', 'main', origin)
  return { tmp, home: path.join(tmp, 'home'), repo, origin }
}

async function launch(home: string, repo: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/investigate-by-role.json', MAINBUS_TEST_REPO: repo }
  })
  const page = await app.firstWindow()
  await page.getByRole('button', { name: 'Add workspace' }).click()
  return { app, page }
}

async function startInvestigation(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New ticket' }).click()
  await page.getByRole('radio', { name: /^Investigate/ }).check()
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('In your words').fill('Find out why login is slow')
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: new RegExp(title) }).click()
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByText('Ready for review', { exact: true })).toBeVisible()
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function cleanUp(tmp: string | null): void {
  if (!tmp) return
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A temp folder left behind is harmless.
  }
}

// The app runs with a fake agent and a fake GitHub CLI (test runs never reach GitHub); git pushes to a local
// bare repository standing in for origin.
test("an Investigate ticket's report is committed on its branch as docs/investigations/<date>-<n>-<slug>.md, and with PRs on a PR is opened", async () => {
  let tmp: string | null = null
  let app: ElectronApplication | null = null
  try {
    const made = makeRepos()
    tmp = made.tmp
    const { repo, origin } = made
    git(repo, 'remote', 'add', 'origin', origin)
    let page: Page
    ;({ app, page } = await launch(made.home, repo))

    // Saving reports is on by default; switch PRs on.
    await page.getByRole('button', { name: 'Workspace settings' }).click()
    await expect(page.getByRole('switch', { name: /^Save investigation reports in the repo/ })).toBeChecked()
    await expect(page.getByRole('textbox', { name: /^Reports folder/ })).toHaveValue('docs/investigations')
    await page.getByRole('switch', { name: /^Open a PR when a ticket reaches Review/ }).check()
    await page.keyboard.press('Escape')

    await startInvestigation(page, 'Why is login slow')
    const file = `docs/investigations/${today()}-1-why-is-login-slow.md`
    const branch = 'mainbus/1-why-is-login-slow'

    // The ticket view shows the file under the report, with the commit.
    const saved = page.locator('[data-event="report_file"]')
    await expect(saved).toContainText(`Saved as ${file} in commit`)
    await expect(saved).toContainText(`on ${branch}`)
    await expect(page.getByRole('link', { name: 'PR #1' }).first()).toHaveAttribute('href', 'https://github.com/example/repo/pull/1')

    // Committed by Mainbus on the ticket's branch, with the repo's identity, and pushed to origin.
    expect(git(repo, 'log', '-1', '--format=%s|%an', branch).trim()).toBe('Investigation #1: Why is login slow|Mainbus E2E')
    const text = git(repo, 'show', `${branch}:${file}`)
    expect(text).toContain('> **Investigation #1:** Why is login slow')
    expect(text).toContain("> **The question (the user's words):** Find out why login is slow")
    expect(text).toContain('\n\n# Findings\n\nThe cause is **X**.\n')
    expect(git(origin, 'rev-parse', `refs/heads/${branch}`).trim()).toBe(git(repo, 'rev-parse', branch).trim())
    // Nothing reached main: that is the user's merge.
    expect(git(repo, 'log', '--format=%s', 'main').trim()).toBe('initial')
  } finally {
    await app?.close().catch(() => {})
    cleanUp(tmp)
  }
})

test('with PRs off the report is still committed on the branch, and nothing is pushed', async () => {
  let tmp: string | null = null
  let app: ElectronApplication | null = null
  try {
    const made = makeRepos()
    tmp = made.tmp
    git(made.repo, 'remote', 'add', 'origin', made.origin)
    let page: Page
    ;({ app, page } = await launch(made.home, made.repo))
    await startInvestigation(page, 'Why is login slow')

    const file = `docs/investigations/${today()}-1-why-is-login-slow.md`
    await expect(page.locator('[data-event="report_file"]')).toContainText(`Saved as ${file}`)
    expect(git(made.repo, 'show', '--name-only', '--format=', 'mainbus/1-why-is-login-slow').trim()).toBe(file)
    await expect(page.getByRole('link', { name: /PR #/ })).toHaveCount(0)
    expect(git(made.origin, 'branch', '--list').trim()).toBe('')
  } finally {
    await app?.close().catch(() => {})
    cleanUp(tmp)
  }
})
