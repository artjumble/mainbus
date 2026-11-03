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

test('dragging a Backlog card into In progress proposes a start in the panel; the card moves only once confirmed', async () => {
  const { tmp, home, repo } = makeRepo()
  let app: ElectronApplication | undefined
  try {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env['ELECTRON_RUN_AS_NODE']
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/orchestrator-drag.json', MAINBUS_TEST_REPO: repo }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Add workspace' }).click()

    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Add hello file')
    await page.getByLabel('In your words').fill('Add hello.txt')
    await page.getByRole('button', { name: 'Create' }).click()
    const backlog = page.getByRole('region', { name: 'Backlog' })
    await expect(backlog.getByRole('button', { name: /Add hello file/ })).toBeVisible()

    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    await panel.getByRole('button', { name: 'Collapse orchestrator panel' }).click()
    await expect(panel.getByRole('textbox', { name: 'Message the orchestrator' })).toHaveCount(0)

    async function dragToInProgress(): Promise<void> {
      const from = (await backlog.getByRole('button', { name: /Add hello file/ }).boundingBox())!
      const to = (await page.getByRole('region', { name: 'In progress' }).boundingBox())!
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
      await page.mouse.down()
      await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2, { steps: 5 })
      await page.mouse.move(to.x + to.width / 2, to.y + 40, { steps: 10 })
      await page.mouse.up()
    }

    // The drop expands the panel to a start proposal; no orchestrator turn, and the card stays put.
    await dragToInProgress()
    const card = panel.getByRole('group', { name: 'Proposal: Start #1 Add hello file' })
    await expect(card).toBeVisible()
    await expect(card.getByText('Why: You dragged #1 "Add hello file" into In progress.')).toBeVisible()
    await expect(card.getByRole('list', { name: 'Roles' }).getByRole('listitem')).toHaveCount(3)
    await expect(panel.getByText('Working…')).toHaveCount(0)
    await expect(backlog.getByRole('button', { name: /Add hello file/ })).toBeVisible()

    // Rejecting leaves it in Backlog.
    await expect(async () => {
      await card.getByRole('button', { name: 'Reject' }).click({ timeout: 500 })
      await expect(card).toHaveCount(0, { timeout: 500 })
    }).toPass()
    await expect(panel.locator('[data-proposal="receipt"]')).toContainText('Rejected')
    await expect(backlog.getByRole('button', { name: /Add hello file/ })).toBeVisible()

    // Drag again and confirm: it starts.
    await dragToInProgress()
    const again = panel.getByRole('group', { name: 'Proposal: Start #1 Add hello file' })
    // dnd-kit swallows clicks for 50 ms after a drop, so the first click may need a second try.
    await expect(async () => {
      await again.getByRole('button', { name: 'Confirm', exact: true }).click({ timeout: 500 })
      await expect(again).toHaveCount(0, { timeout: 500 })
    }).toPass()
    await expect(page.getByRole('region', { name: 'In progress' }).getByRole('button', { name: /Add hello file/ })).toBeVisible()
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
