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

async function launch(home: string, repo: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: {
      ...env,
      MAINBUS_HOME: home,
      // The Planner hands off on the first message and the Reviewer at once; the Implementer asks and requests.
      MAINBUS_RUNTIME: 'fake:e2e/fixtures/ask-then-handoff-by-role.json',
      MAINBUS_TEST_REPO: repo
    }
  })
  const page = await app.firstWindow()
  return { app, page }
}

test('ticket goes from idea to review with a question, a permission and a restart', async () => {
  let tmp: string | null = null
  let session: { app: ElectronApplication; page: Page } | null = null
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
    const home = path.join(tmp, 'home')
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init')
    fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'initial')

    session = await launch(home, repo)
    let { page } = session

    // Open the repo (the hook skips the folder dialog).
    await page.getByRole('button', { name: 'Open a repo folder' }).click()

    // 1. Create the ticket.
    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Add hello file')
    await page.getByLabel('In your words').fill('Add hello.txt')
    await page.getByRole('button', { name: 'Create' }).click()

    // 2. Open it, send a first message. The scripted Planner hands off on it; the Implementer then waits for a
    //    second message, so "Add hello file is implementing" holds steadily until we send it.
    await page.getByRole('button', { name: /Add hello file/ }).click()
    await page.getByLabel('First message (starts the lineup)').fill('Please add hello.txt')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()
    await expect(page.getByRole('heading', { name: 'Add hello file' })).toBeVisible()
    await expect(page.getByText('Implementing', { exact: true })).toBeVisible()
    await expect(page.getByText('Looking at the repo before I add hello.txt.')).toBeVisible()
    // The composer clears only once the first send has gone through; filling before then would lose the text.
    await expect(page.getByLabel('Message the Implementer')).toHaveValue('')
    await page.getByLabel('Message the Implementer').fill('Go ahead')
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click()

    // 3. Answer the question with option 1.
    const question = page.locator('[data-event="decision"]')
    await expect(question).toBeVisible()
    await question.getByRole('radio').first().check()
    await question.getByRole('button', { name: 'Answer' }).click()

    // 4. Allow the permission for this workspace.
    const permission = page.locator('[data-event="permission"]')
    await expect(permission).toBeVisible()
    await permission.getByRole('button', { name: 'Always allow in this workspace' }).click()

    // 5. The ticket lands in Review.
    await expect(page.getByText('Ready for review', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /board/ }).click()
    await expect(page.getByRole('region', { name: 'Review' }).getByText('Add hello file')).toBeVisible()

    // 6. Restart on the same home: the ticket is still in Review and its thread is intact.
    await session.app.close()
    session = await launch(home, repo)
    ;({ page } = session)
    const review = page.getByRole('region', { name: 'Review' })
    await expect(review.getByText('Add hello file')).toBeVisible()
    await review.getByText('Add hello file').click()
    await expect(page.getByText('Please add hello.txt')).toBeVisible()
    await expect(page.getByText('Looking at the repo before I add hello.txt.')).toBeVisible()
    await expect(page.getByText('Go ahead')).toBeVisible()
    await expect(page.locator('[data-event="decision"]')).toContainText('✓ Answered: Repo root')
    await expect(page.locator('[data-event="permission"]')).toContainText('✓ Answered: Always allowed in this workspace')
  } finally {
    await session?.app.close().catch(() => {})
    // Cleanup must never hide the test's own failure.
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // A temp folder left behind is harmless.
      }
    }
  }
})
