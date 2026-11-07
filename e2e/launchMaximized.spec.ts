import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { makeRepo } from './artboardHelpers'

const root = path.resolve(import.meta.dirname, '..')

// Other specs keep the fixed 1280×800 window; MAINBUS_TEST_MAXIMIZED=1 asks for the normal, maximized launch.
test('the main window opens maximized', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-maximized-'))
  let app: ElectronApplication | undefined
  try {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env['ELECTRON_RUN_AS_NODE']
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: {
        ...env,
        MAINBUS_HOME: path.join(tmp, 'home'),
        MAINBUS_RUNTIME: 'fake:e2e/fixtures/artboard-detail-by-role.json',
        MAINBUS_TEST_REPO: makeRepo(tmp, 'web-app'),
        MAINBUS_TEST_MAXIMIZED: '1'
      }
    })
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: 'Add workspace' })).toBeVisible()
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized())).toBe(true)
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // Windows can hold a file briefly after the app quits.
    }
  }
})
