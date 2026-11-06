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
    env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/restart-recovery-by-role.json', MAINBUS_TEST_REPO: repo }
  })
  const page = await app.firstWindow()
  return { app, page }
}

async function createTicket(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New ticket' }).click()
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('In your words').fill(title)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible()
}

/** Ends the app's whole process tree at once, with no orderly shutdown: only the process this test started. */
async function kill(app: ElectronApplication): Promise<void> {
  const child = app.process()
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('exit', () => resolve())
  })
  if (process.platform === 'win32') {
    execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'pipe' })
  } else {
    process.kill(child.pid!, 'SIGKILL')
  }
  await exited
}

test('after the app is killed mid-run, the working agents resume and a pending question still reaches its agent', async () => {
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
    await page.getByRole('button', { name: 'Add workspace' }).click()
    for (const title of ['Alpha ticket', 'Bravo ticket', 'Charlie ticket']) await createTicket(page, title)

    // Two tickets start normally; their Planners stay working.
    for (const title of ['Alpha ticket', 'Bravo ticket']) {
      await page.getByRole('button', { name: new RegExp(title) }).click()
      await page.getByRole('button', { name: 'Start', exact: true }).click()
      await expect(page.getByText('Planner: on it.')).toBeVisible()
      await page.getByRole('button', { name: /board/ }).click()
    }

    // The third runs only its Implementer, which asks a question and waits for the answer.
    await page.getByRole('button', { name: /Charlie ticket/ }).click()
    await page.getByRole('button', { name: 'Run settings…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Run settings' })
    await dialog.getByRole('checkbox', { name: 'Planner' }).uncheck()
    await dialog.getByRole('checkbox', { name: 'Reviewer' }).uncheck()
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.locator('[data-event="decision"]')).toContainText('Where should hello.txt go?')
    await page.getByRole('button', { name: /board/ }).click()
    await expect(page.getByRole('region', { name: 'Needs you' }).getByText('Charlie ticket')).toBeVisible()

    // Killed, not closed: nothing shuts down in order.
    await kill(session.app)
    session = await launch(home, repo)
    ;({ page } = session)

    // The board shows at once; both Planners come back with the restart message, with every earlier event kept.
    for (const title of ['Alpha ticket', 'Bravo ticket']) {
      await page.getByRole('button', { name: new RegExp(title) }).click()
      await expect(page.getByText('Planner: back after the restart.')).toBeVisible()
      await expect(page.getByText('Planner: on it.')).toBeVisible()
      await page.getByRole('button', { name: /board/ }).click()
    }

    // The question is still pending, and its answer reaches the agent.
    await expect(page.getByRole('region', { name: 'Needs you' }).getByText('Charlie ticket')).toBeVisible()
    await page.getByRole('button', { name: 'Charlie ticket', exact: true }).click()
    const question = page.locator('[data-event="decision"]')
    await expect(question).toContainText('Where should hello.txt go?')
    await question.getByRole('radio').first().check()
    await question.getByRole('button', { name: 'Answer' }).click()
    await expect(page.getByText('Implementer: got the answer.')).toBeVisible()
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
