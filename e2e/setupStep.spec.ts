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

function cleanUp(tmp: string | null): void {
  if (!tmp) return
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A temp folder left behind is harmless.
  }
}

// The app runs with a fake agent in a throwaway repository and a temporary MAINBUS_HOME. The setup command is the
// user's own small script, run by Mainbus for real.
test('the setup command runs in a new ticket folder before the first role starts, and its output shows in the thread', async () => {
  let tmp: string | null = null
  let app: ElectronApplication | null = null
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
    // The marker is a build artifact like node_modules: without this the dirty folder would stop the handoff.
    fs.writeFileSync(path.join(repo, '.gitignore'), 'setup-marker.txt\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'initial')

    const script = path.join(tmp, 'mark.cjs')
    fs.writeFileSync(
      script,
      "require('node:fs').writeFileSync('setup-marker.txt', 'set up\\n'); console.log('setup line 1'); console.log('setup line 2'); console.log('setup line 3')\n"
    )

    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env['ELECTRON_RUN_AS_NODE']
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: {
        ...env,
        MAINBUS_HOME: path.join(tmp, 'home'),
        MAINBUS_RUNTIME: 'fake:e2e/fixtures/setup-marker.json',
        MAINBUS_TEST_REPO: repo
      }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Add workspace' }).click()

    // Empty by default; set the command in the workspace settings.
    await page.getByRole('button', { name: 'Workspace settings' }).click()
    const command = page.getByRole('textbox', { name: 'Setup command for new ticket folders' })
    await expect(command).toHaveValue('')
    await command.fill(`node "${script.replaceAll(path.sep, '/')}"`)
    await page.getByRole('button', { name: 'Save setup' }).click()
    await expect(page.getByRole('button', { name: 'Save setup' })).toBeDisabled()
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Add the file')
    await page.getByLabel('In your words').fill('Add the file')
    await page.getByLabel('Column').selectOption('ready')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('region', { name: 'Ready' }).getByText('Add the file').click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()

    // The fake agent's first step fails the run unless the marker was in its folder, so reaching Review proves it.
    await expect(page.getByText('Ready for review')).toBeVisible()
    const worktree = path.join(tmp, 'home', 'work')
    const marker = fs.readdirSync(worktree).flatMap((ws) => fs.readdirSync(path.join(worktree, ws)).map((t) => path.join(worktree, ws, t, 'setup-marker.txt')))
    expect(marker.filter((m) => fs.existsSync(m))).toHaveLength(1)

    // The thread has a collapsed Setup entry, with its output a click away.
    const entry = page.locator('[data-event="setup"]')
    await expect(entry).toHaveCount(1)
    await expect(entry).toContainText('exited 0')
    await expect(entry.getByRole('button', { name: 'Show output' })).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText('setup line 3')).toHaveCount(0)
    await entry.getByRole('button', { name: 'Show output' }).click()
    await expect(entry).toContainText('setup line 3')
  } finally {
    await app?.close().catch(() => {})
    cleanUp(tmp)
  }
})
