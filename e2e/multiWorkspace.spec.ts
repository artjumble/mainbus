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

function makeRepo(dir: string): string {
  fs.mkdirSync(dir)
  git(dir, 'init')
  fs.writeFileSync(path.join(dir, 'README.md'), '# test repo\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'initial')
  return dir
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

async function startTicket(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(title) }).click()
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByText('Planner: on it.')).toBeVisible()
  await page.getByRole('button', { name: /board/ }).click()
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

// There is no screen for opening a second repo or switching yet (the rail comes next), so the test sends the engine's
// commands straight through the preload bridge.
const invoke = (page: Page, command: string, ...args: unknown[]): Promise<{ id: string }> =>
  page.evaluate(
    ([c, a]) =>
      (globalThis as unknown as { mainbus: { invoke: (c: string, ...a: unknown[]) => Promise<{ id: string }> } }).mainbus.invoke(
        c as string,
        ...(a as unknown[])
      ),
    [command, args] as const
  )

test('two repos are open at once: an agent runs in each, focus switches the board, and both resume after a kill', async () => {
  let tmp: string | null = null
  let session: { app: ElectronApplication; page: Page } | null = null
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
    const home = path.join(tmp, 'home')
    const repoA = makeRepo(path.join(tmp, 'alpha-repo'))
    const repoB = makeRepo(path.join(tmp, 'bravo-repo'))

    session = await launch(home, repoA)
    let { page } = session
    await page.getByRole('button', { name: 'Add workspace' }).click()
    await createTicket(page, 'Alpha ticket')
    await startTicket(page, 'Alpha ticket')
    const a = await invoke(page, 'workspace.get')

    // The second repo opens and takes the focus: the board shows its own (empty) tickets.
    const b = await invoke(page, 'workspace.open', repoB)
    expect(b.id).not.toBe(a.id)
    await expect(page.getByRole('button', { name: /Alpha ticket/ })).toHaveCount(0)
    await createTicket(page, 'Bravo ticket')
    await startTicket(page, 'Bravo ticket')

    // Switching focus brings the other board back.
    await invoke(page, 'workspace.focus', a.id)
    await expect(page.getByRole('button', { name: /Alpha ticket/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Bravo ticket/ })).toHaveCount(0)

    // Killed, not closed: the focus (on A) and both agents are remembered.
    await kill(session.app)
    session = await launch(home, repoA)
    ;({ page } = session)

    await page.getByRole('button', { name: /Alpha ticket/ }).click()
    await expect(page.getByText('Planner: back after the restart.')).toBeVisible()
    await page.getByRole('button', { name: /board/ }).click()

    await invoke(page, 'workspace.focus', b.id)
    await page.getByRole('button', { name: /Bravo ticket/ }).click()
    await expect(page.getByText('Planner: back after the restart.')).toBeVisible()
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
