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

test('the orchestrator proposes starting a Backlog ticket; the user drops the Planner and changes a model; it starts with those roles', async () => {
  const { tmp, home, repo } = makeRepo()
  let app: ElectronApplication | undefined
  try {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env['ELECTRON_RUN_AS_NODE']
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/orchestrator-start.json', MAINBUS_TEST_REPO: repo }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Add workspace' }).click()

    // Ticket #1, in Backlog.
    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Add hello file')
    await page.getByLabel('In your words').fill('Add hello.txt')
    await page.getByRole('button', { name: 'Create' }).click()
    const backlog = page.getByRole('region', { name: 'Backlog' })
    await expect(backlog.getByRole('button', { name: /Add hello file/ })).toBeVisible()

    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    const box = panel.getByRole('textbox', { name: 'Message the orchestrator' })
    await box.fill('Start the hello ticket.')
    await box.press('Enter')
    await expect(panel.getByText("I've proposed starting #1.")).toBeVisible()

    // The card: the lineup in order, the extra instructions and why.
    const card = panel.getByRole('group', { name: 'Proposal: Start #1 Add hello file' })
    await expect(card.getByText('PROPOSED ACTION', { exact: false })).toBeVisible()
    await expect(card.getByLabel('Roles')).toContainText('lineup: Planner → Implementer → Reviewer')
    await expect(card.getByText('Extra instructions: Keep the change to one file.')).toBeVisible()
    await expect(card.getByText('Why: #1 is specced and nothing is running.')).toBeVisible()
    // Nothing starts before the user confirms.
    await expect(backlog.getByRole('button', { name: /Add hello file/ })).toBeVisible()

    // Override: drop the Planner and put the Implementer on Opus.
    await card.getByRole('button', { name: 'Override' }).click()
    await card.getByRole('checkbox', { name: '1. Planner' }).uncheck()
    // The models and effort are in a collapsed section, with each role's as proposed.
    await card.getByRole('button', { name: /Models and effort per role/ }).click()
    await expect(card.getByRole('combobox', { name: 'Model for Planner' })).toHaveValue('opus')
    await expect(card.getByRole('combobox', { name: 'Model for Reviewer' })).toHaveValue('haiku')
    // By value: the label carries the version the user's `claude` names (Opus 5.5 with the fake runtime).
    await card.getByRole('combobox', { name: 'Model for Implementer' }).selectOption('opus')
    await card.getByRole('button', { name: 'Start', exact: true }).click()

    const receipt = panel.locator('[data-proposal="receipt"]')
    await expect(receipt).toContainText('✓ Add hello file is in')

    // It left Backlog for In progress, and its lineup begins with the Implementer.
    const inProgress = page.getByRole('region', { name: 'In progress' })
    await expect(inProgress.getByRole('button', { name: /Add hello file/ })).toBeVisible()
    await receipt.getByRole('button', { name: 'Open ticket' }).click()
    await expect(page.getByRole('heading', { name: 'Add hello file' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'Lineup' }).getByRole('listitem')).toHaveText(
      ['Implementer • Working', 'Reviewer ○ Not started'],
      { useInnerText: true }
    )
    await expect(page.getByText('Implementer: adding the file.')).toBeVisible()
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
