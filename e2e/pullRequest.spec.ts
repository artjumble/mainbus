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

/** A temp folder with a repo (no origin yet) and a bare repository to use as origin. */
function makeRepos(): { tmp: string; home: string; repo: string; origin: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  const repo = path.join(tmp, 'repo')
  const origin = path.join(tmp, 'origin.git')
  fs.mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
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
    env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/handoff.json', MAINBUS_TEST_REPO: repo }
  })
  const page = await app.firstWindow()
  await page.getByRole('button', { name: 'Open a repo folder' }).click()
  return { app, page }
}

async function switchPrsOn(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Workspace settings' }).click()
  const toggle = page.getByRole('switch', { name: /^Open a PR when a ticket reaches Review/ })
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  await expect(toggle).toBeChecked()
  await page.keyboard.press('Escape')
}

async function createReadyTicket(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New ticket' }).click()
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('In your words').fill(title)
  await page.getByLabel('Put it in Ready (otherwise Backlog)').check()
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('region', { name: 'Ready' }).getByText(title)).toBeVisible()
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
test('a handoff opens a PR once origin is there: the failure shows with Retry, and Retry opens it', async () => {
  let tmp: string | null = null
  let app: ElectronApplication | null = null
  try {
    const made = makeRepos()
    tmp = made.tmp
    const { repo, origin } = made
    let page: Page
    ;({ app, page } = await launch(made.home, repo))

    // Off by default; switch it on in the workspace settings.
    await switchPrsOn(page)
    await createReadyTicket(page, 'Add the file')
    await page.getByRole('region', { name: 'Ready' }).getByText('Add the file').click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()

    // The repo has no origin yet: the ticket still reaches Review, with the reason and a Retry.
    await expect(page.getByText('Ready for review')).toBeVisible()
    await expect(page.getByText("Couldn't open a PR: the repository has no origin remote").first()).toBeVisible()

    git(repo, 'remote', 'add', 'origin', origin)
    await page.getByRole('button', { name: 'Retry' }).click()

    await expect(page.getByRole('link', { name: 'PR #1' }).first()).toHaveAttribute('href', 'https://github.com/example/repo/pull/1')
    // The notice and its Retry are gone; the thread keeps the record of the failure.
    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0)
    await expect(page.locator('[data-event="pull_request"]')).toHaveText('Pushed mainbus/1-add-the-file and opened PR #1')
    expect(git(origin, 'rev-parse', 'refs/heads/mainbus/1-add-the-file').trim()).toMatch(/^[0-9a-f]{40}$/)

    // The board card links to it too.
    await page.getByRole('button', { name: /board$/ }).click()
    const card = page.getByRole('region', { name: 'Review' })
    await expect(card.getByRole('link', { name: 'PR #1' })).toBeVisible()
  } finally {
    await app?.close().catch(() => {})
    cleanUp(tmp)
  }
})

test('unattended mode opens PRs for queue tickets, and a PR failure does not stop the queue', async () => {
  let tmp: string | null = null
  let app: ElectronApplication | null = null
  try {
    const made = makeRepos()
    tmp = made.tmp
    let page: Page
    ;({ app, page } = await launch(made.home, made.repo))
    await switchPrsOn(page)
    await createReadyTicket(page, 'First queued ticket')
    await createReadyTicket(page, 'Second queued ticket')

    // No origin: neither PR can be opened, but both tickets reach Review and the queue runs to the end.
    await page.getByRole('switch', { name: 'Unattended' }).check()
    const review = page.getByRole('region', { name: 'Review' })
    await expect(review.getByText('First queued ticket')).toBeVisible()
    await expect(review.getByText('Second queued ticket')).toBeVisible()
    await expect(page.getByTestId('unattended-status')).toHaveText('Waiting for Ready tickets')
    await review.getByText('Second queued ticket').click()
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
    await page.getByRole('button', { name: /board$/ }).click()

    // With origin there, the next queue ticket gets its PR. The mode is still on and starts it from Ready.
    git(made.repo, 'remote', 'add', 'origin', made.origin)
    await createReadyTicket(page, 'Third queued ticket')
    await expect(review.getByText('Third queued ticket')).toBeVisible()
    await expect(review.getByRole('link', { name: 'PR #1' })).toBeVisible()
    expect(git(made.origin, 'rev-parse', 'refs/heads/mainbus/3-third-queued-ticket').trim()).toMatch(/^[0-9a-f]{40}$/)
  } finally {
    await app?.close().catch(() => {})
    cleanUp(tmp)
  }
})
