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

const ASK = 'Please add two tickets: a login page, and a logout button in the header.'

test('the orchestrator drafts two tickets; the user edits one title in Override and confirms; both land in Backlog with the user’s words', async () => {
  const { tmp, home, repo } = makeRepo()
  let app: ElectronApplication | undefined
  try {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env['ELECTRON_RUN_AS_NODE']
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/orchestrator-drafting.json', MAINBUS_TEST_REPO: repo }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Open a repo folder' }).click()
    const panel = page.getByRole('complementary', { name: 'Orchestrator' })

    // The user asks in plain words.
    const box = panel.getByRole('textbox', { name: 'Message the orchestrator' })
    await box.fill(ASK)
    await box.press('Enter')
    await expect(panel.getByText("I've drafted two tickets for you to confirm.")).toBeVisible()

    // The proposal's card, with the drafts and why.
    const card = panel.getByRole('group', { name: 'Proposal: Create 2 tickets in Backlog' })
    await expect(card).toBeVisible()
    await expect(card.getByText('Add a login page')).toBeVisible()
    await expect(card.getByText('Add a logout button')).toBeVisible()
    await expect(card.getByText('Why: The README mentions accounts, and src/ has no auth code yet.')).toBeVisible()
    // Nothing is created before the user confirms.
    const backlog = page.getByRole('region', { name: 'Backlog' })
    await expect(backlog.getByRole('button', { name: /Add a login page/ })).toHaveCount(0)

    // Override: edit the first title, then confirm with the changes.
    await card.getByRole('button', { name: 'Override' }).click()
    const title = card.getByRole('group', { name: 'Draft 1' }).getByRole('textbox', { name: 'Title' })
    await expect(title).toHaveValue('Add a login page')
    await title.fill('Add a sign-in page')
    await card.getByRole('button', { name: 'Confirm with changes' }).click()

    // The card collapses to its receipt.
    const receipt = panel.locator('[data-proposal="receipt"]')
    await expect(receipt).toContainText('Created #1 and #2')
    await expect(panel.getByRole('group', { name: /^Proposal:/ })).toHaveCount(0)

    // Both are in Backlog: the edited title and the original one.
    await expect(backlog.getByRole('button', { name: /Add a sign-in page/ })).toBeVisible()
    await expect(backlog.getByRole('button', { name: /Add a logout button/ })).toBeVisible()
    await expect(backlog.getByRole('button', { name: /Add a login page/ })).toHaveCount(0)

    // Its intent is the user's message, verbatim; the orchestrator's drafting is in the spec.
    await receipt.getByRole('button', { name: '#1' }).click()
    await expect(page.getByRole('heading', { name: 'Add a sign-in page' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Your words' }).getByText(ASK, { exact: true })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Spec' })).toHaveValue(
      'Drafted by the orchestrator: a form at /login that posts to the session endpoint.'
    )
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
