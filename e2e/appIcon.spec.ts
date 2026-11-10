import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { makeRepo } from './artboardHelpers'

const root = path.resolve(import.meta.dirname, '..')

test('the window and the tray use the app icon', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-icon-'))
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
        MAINBUS_TEST_REPO: makeRepo(tmp, 'web-app')
      }
    })
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: 'Add workspace' })).toBeVisible()
    // Each window was given the 256 px app icon from resources/icons, and Electron can load it.
    const icons = await app.evaluate(({ BrowserWindow, nativeImage }) => {
      const given = (globalThis as { __mainbusWindowIcons?: Record<number, string> }).__mainbusWindowIcons ?? {}
      return BrowserWindow.getAllWindows().map((win) => {
        const file = given[win.id] ?? ''
        return { file: file.replaceAll('\\', '/'), size: file ? nativeImage.createFromPath(file).getSize() : null }
      })
    })
    expect(icons).toEqual([{ file: expect.stringMatching(/\/resources\/icons\/mainbus-256\.png$/), size: { width: 256, height: 256 } }])
    // The tray started: it is exposed only once its icon, built from the glyph PNGs, is in place.
    await expect.poll(() => app!.evaluate(() => Boolean((globalThis as { __mainbusTray?: unknown }).__mainbusTray))).toBe(true)
    // The page has its favicon.
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', /favicon\.ico$/)
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // Windows can hold a file briefly after the app quits.
    }
  }
})
