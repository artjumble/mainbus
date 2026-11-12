import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '..')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    windowsHide: true,
    stdio: 'pipe',
    encoding: 'utf8'
  })
}

// A throwaway repo checked out on a feature branch: adding it warns, Cancel adds nothing, Add anyway uses that branch.
test('adding a folder on a feature branch warns; Cancel adds nothing and Add anyway uses that base', async () => {
  let tmp: string | null = null
  let app: ElectronApplication | null = null
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
    const folder = path.join(tmp, 'repo')
    fs.mkdirSync(folder)
    git(folder, 'init', '-b', 'main')
    fs.writeFileSync(path.join(folder, 'README.md'), '# repo\n')
    git(folder, 'add', '.')
    git(folder, 'commit', '-m', 'initial')
    git(folder, 'switch', '-c', 'fm/feature')

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
        MAINBUS_TEST_REPO: folder
      }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Add workspace' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add workspace' })
    await expect(dialog.getByText(/You're on fm\/feature\. Mainbus uses the checked-out branch/)).toBeVisible()
    await expect(dialog.getByText("This branch isn't on origin", { exact: false })).toHaveCount(0)

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('button', { name: 'New ticket' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add workspace' })).toBeVisible()

    await page.getByRole('button', { name: 'Add workspace' }).click()
    await dialog.getByRole('button', { name: 'Add anyway' }).click()
    await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible()

    await page.getByRole('button', { name: 'Workspace settings' }).click()
    await expect(page.getByText('opens a pull request against fm/feature', { exact: false })).toBeVisible()
  } finally {
    await app?.close().catch(() => {})
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // A temp folder left behind is harmless.
      }
    }
  }
})
