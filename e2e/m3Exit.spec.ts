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

test('M3 exit: ask for tickets in plain words, confirm the drafts, ask to start one and confirm, all from the panel', async () => {
  const { tmp, home, repo } = makeRepo()
  let app: ElectronApplication | undefined
  try {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env['ELECTRON_RUN_AS_NODE']
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/orchestrator-exit.json', MAINBUS_TEST_REPO: repo }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Open a repo folder' }).click()
    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    const box = panel.getByRole('textbox', { name: 'Message the orchestrator' })

    // 1. The user asks for two tickets in plain words.
    await box.fill('Please add a login page and a logout button.')
    await box.press('Enter')
    await expect(panel.getByText('I have drafted two tickets for you to confirm.')).toBeVisible()

    // 2. They confirm the drafts.
    const draft = panel.getByRole('group', { name: 'Proposal: Create 2 tickets in Backlog' })
    await draft.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(panel.locator('[data-proposal="receipt"]')).toContainText('Created #1 and #2')
    const backlog = page.getByRole('region', { name: 'Backlog' })
    await expect(backlog.getByRole('button', { name: /Add a login page/ })).toBeVisible()
    await expect(backlog.getByRole('button', { name: /Add a logout button/ })).toBeVisible()

    // 3. They ask to start one, and confirm the start proposal.
    await box.fill('Start the first one.')
    await box.press('Enter')
    await expect(panel.getByText('I have proposed starting #1.')).toBeVisible()
    const start = panel.getByRole('group', { name: 'Proposal: Start #1 Add a login page' })
    await expect(start.getByText('Why: #1 is specced and nothing is running.')).toBeVisible()
    await start.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(panel.locator('[data-proposal="receipt"]').last()).toContainText('Started #1 with Planner, Implementer and Reviewer')

    // 4. It runs its lineup and reaches Review; the other ticket stays in Backlog.
    await expect(page.getByRole('region', { name: 'Review' }).getByRole('button', { name: /Add a login page/ })).toBeVisible({
      timeout: 60_000
    })
    await expect(backlog.getByRole('button', { name: /Add a logout button/ })).toBeVisible()
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
