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

async function launch(home: string, repo: string, script: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: `fake:${script}`, MAINBUS_TEST_REPO: repo }
  })
  const page = await app.firstWindow()
  await page.getByRole('button', { name: 'Add workspace' }).click()
  return { app, page }
}

test("an Investigate ticket's report is promoted into a Change ticket in Ready with the same words and the report; the original is Done", async () => {
  const { tmp, home, repo } = makeRepo()
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, repo, 'e2e/fixtures/investigate-by-role.json'))
    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByRole('radio', { name: /^Investigate/ }).check()
    await page.getByLabel('Title').fill('Why is login slow')
    await page.getByLabel('In your words').fill('Find out why login is slow')
    await page.getByRole('button', { name: 'Create' }).click()

    await page.getByRole('button', { name: /Why is login slow/ }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByText('Ready for review', { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Report' }).getByRole('heading', { name: 'Findings' })).toBeVisible()

    await page.getByRole('button', { name: 'Promote', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Promote to a Change ticket' })
    // The fake runtime's summary stands in for the drafted spec.
    await expect(dialog.getByLabel('Spec')).toHaveValue('A summary the fake runtime wrote.')
    await dialog.getByLabel('Title').fill('Speed up login')
    await dialog.getByRole('button', { name: 'Promote', exact: true }).click()
    await expect(dialog).toBeHidden()

    // The original is Done and now links to the new ticket.
    await expect(page.getByText('Promoted to')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Promote', exact: true })).toHaveCount(0)

    await page.getByRole('button', { name: /board/ }).click()
    // Done is a narrow strip: its cards show while it is hovered.
    await page.getByRole('region', { name: 'Done' }).hover()
    await expect(page.getByRole('region', { name: 'Done' }).getByText('Why is login slow')).toBeVisible()
    const ready = page.getByRole('region', { name: 'Ready' })
    await expect(ready.getByText('Speed up login')).toBeVisible()

    // The new ticket has the same words and the report, and links back.
    await ready.getByRole('button', { name: /Speed up login/ }).click()
    await expect(page.getByRole('region', { name: 'Your words' }).getByText('Find out why login is slow')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Investigation report' }).getByRole('heading', { name: 'Findings' })).toBeVisible()
    await expect(page.getByText('Promoted from')).toBeVisible()

    // And back on the original.
    await page.getByRole('button', { name: /#1 Why is login slow/ }).click()
    await expect(page.getByText('Promoted to')).toBeVisible()
    // Nothing was committed to the repo's main branch.
    expect(git(repo, 'log', '--format=%s', 'main').trim()).toBe('initial')
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
  }
})
