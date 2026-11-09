import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '..')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe', encoding: 'utf8' })
}

function cleanUp(tmp: string | null): void {
  if (!tmp) return
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A temp folder left behind is harmless.
  }
}

// A plain folder with a .env: Mainbus offers to set git up, flags the .env, and after setup a ticket's folder has the
// files but not the secret. The identity comes from the environment; the machine's git config is never touched.
test('a plain folder is set up with one commit, its .env left out, and no remote', async () => {
  let tmp: string | null = null
  let app: ElectronApplication | null = null
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
    const folder = path.join(tmp, 'plain')
    fs.mkdirSync(path.join(folder, 'src'), { recursive: true })
    fs.writeFileSync(path.join(folder, 'README.md'), '# plain\n')
    fs.writeFileSync(path.join(folder, 'src', 'app.txt'), 'app\n')
    fs.writeFileSync(path.join(folder, '.env'), 'SECRET=1\n')

    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env['ELECTRON_RUN_AS_NODE']
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: {
        ...env,
        MAINBUS_HOME: path.join(tmp, 'home'),
        MAINBUS_RUNTIME: 'fake:e2e/fixtures/git-setup.json',
        MAINBUS_TEST_REPO: folder,
        GIT_AUTHOR_NAME: 'Mainbus E2E',
        GIT_AUTHOR_EMAIL: 'e2e@mainbus.test',
        GIT_COMMITTER_NAME: 'Mainbus E2E',
        GIT_COMMITTER_EMAIL: 'e2e@mainbus.test'
      }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Add workspace' }).click()

    const dialog = page.getByRole('dialog', { name: 'Add workspace' })
    await expect(dialog.getByText('Set up git here')).toBeVisible()
    await expect(dialog.getByText('.env: looks like a secret')).toBeVisible()
    expect(fs.existsSync(path.join(folder, '.git'))).toBe(false)
    await dialog.getByRole('checkbox', { name: 'Add a .gitignore for the flagged items' }).check()
    await dialog.getByRole('button', { name: 'Set up and add workspace' }).click()

    await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible()
    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Look at the files')
    await page.getByLabel('In your words').fill('Look at the files')
    await page.getByLabel('Column').selectOption('ready')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('region', { name: 'Ready' }).getByText('Look at the files').click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    // The fake agent's first step fails the run unless README.md was in its folder.
    await expect(page.getByText('Ready for review')).toBeVisible()

    const work = path.join(tmp, 'home', 'work')
    const folders = fs.readdirSync(work).flatMap((ws) => fs.readdirSync(path.join(work, ws)).map((t) => path.join(work, ws, t)))
    expect(folders).toHaveLength(1)
    expect(fs.existsSync(path.join(folders[0]!, 'README.md'))).toBe(true)
    expect(fs.existsSync(path.join(folders[0]!, 'src', 'app.txt'))).toBe(true)
    expect(fs.existsSync(path.join(folders[0]!, '.env'))).toBe(false)

    expect(git(folder, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
    expect(git(folder, 'remote').trim()).toBe('')
  } finally {
    await app?.close().catch(() => {})
    cleanUp(tmp)
  }
})
