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

test('an Investigate ticket is worked by the Investigator, which submits a report: the ticket lands in Review and shows the report', async () => {
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

    const card = page.getByRole('button', { name: /Why is login slow/ })
    await expect(card).toBeVisible()
    await expect(page.getByRole('region', { name: 'Backlog' }).getByText('Investigate', { exact: true })).toBeVisible()
    await card.click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()

    await expect(page.getByText('Ready for review', { exact: true })).toBeVisible()
    const report = page.getByRole('region', { name: 'Report' })
    await expect(report.getByRole('heading', { name: 'Findings' })).toBeVisible()
    // The thread is still there above it.
    await expect(page.getByText('Investigator: reading the code.')).toBeVisible()

    await page.getByRole('button', { name: /board/ }).click()
    await expect(page.getByRole('region', { name: 'Review' }).getByText('Why is login slow')).toBeVisible()
    // No branch was pushed and nothing was committed on the repo's main branch.
    expect(git(repo, 'log', '--format=%s', 'main').trim()).toBe('initial')
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
  }
})
