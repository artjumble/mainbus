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
      MAINBUS_RUNTIME: 'fake:e2e/fixtures/install-then-handoff.json',
      MAINBUS_TEST_REPO: repo
    }
  })
  const page = await app.firstWindow()
  return { app, page }
}

async function createReadyTicket(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New ticket' }).click()
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('In your words').fill(title)
  await page.getByLabel('Put it in Ready (otherwise Backlog)').check()
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('region', { name: 'Ready' }).getByText(title)).toBeVisible()
}

test('unattended mode works through Ready, allows what is not a hard stop, and is back on after a restart', async () => {
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
    await page.getByRole('button', { name: 'Open a repo folder' }).click()

    await createReadyTicket(page, 'First queued ticket')
    await createReadyTicket(page, 'Second queued ticket')
    const status = page.getByTestId('unattended-status')
    await expect(status).toHaveText('Off')

    // Switch it on: both tickets are worked through and land in Review, then the mode stays on and waits.
    await page.getByRole('switch', { name: 'Unattended' }).check()
    const review = page.getByRole('region', { name: 'Review' })
    await expect(review.getByText('First queued ticket')).toBeVisible()
    await expect(review.getByText('Second queued ticket')).toBeVisible()
    await expect(status).toHaveText('Waiting for Ready tickets')
    await expect(page.getByRole('switch', { name: 'Unattended' })).toBeChecked()

    // A ticket that arrives in Ready is started at once (too soon, perhaps, to be seen in Ready).
    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Third queued ticket')
    await page.getByLabel('In your words').fill('Third queued ticket')
    await page.getByLabel('Put it in Ready (otherwise Backlog)').check()
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(review.getByText('Third queued ticket')).toBeVisible()
    await expect(status).toHaveText('Waiting for Ready tickets')

    // The install was allowed without a card, and the thread says so.
    await review.getByText('First queued ticket').click()
    await expect(page.getByText('Allowed by unattended mode: Implementer wants to run `npm install left-pad`')).toBeVisible()
    await expect(page.locator('[data-event="permission"]')).toHaveCount(0)

    // The mode is remembered: it is on again after a restart.
    await session.app.close()
    session = await launch(home, repo)
    ;({ page } = session)
    await expect(page.getByRole('region', { name: 'Review' }).getByText('First queued ticket')).toBeVisible()
    await expect(page.getByRole('switch', { name: 'Unattended' })).toBeChecked()
    await expect(page.getByTestId('unattended-status')).not.toHaveText('Off')
  } finally {
    await session?.app.close().catch(() => {})
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // A temp folder left behind is harmless.
      }
    }
  }
})
