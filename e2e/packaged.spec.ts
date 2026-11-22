import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { addWorkspace } from './addWorkspace'
import { killApp } from './killApp'

// Runs against a packaged build, not out/. Set MAINBUS_E2E_PACKAGED to the packaged executable
// (dist/win-unpacked/Mainbus.exe, or dist/mac-arm64/Mainbus.app/Contents/MacOS/Mainbus). Skipped otherwise.
const executablePath = process.env['MAINBUS_E2E_PACKAGED']
const root = path.resolve(import.meta.dirname, '..')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Mainbus E2E', '-c', 'user.email=e2e@mainbus.test', ...args], {
    cwd,
    windowsHide: true,
    stdio: 'pipe'
  })
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  return env
}

/** The packaged app's resources folder: next to the exe on Windows and Linux, in Contents/Resources on macOS. */
function resourcesDir(exe: string): string {
  const dir = path.dirname(exe)
  return process.platform === 'darwin' ? path.join(dir, '..', 'Resources') : path.join(dir, 'resources')
}

test.skip(!executablePath, 'set MAINBUS_E2E_PACKAGED to a packaged executable')

test('the package leaves out the SDK platform binaries but keeps the SDK', () => {
  const asar = path.join(resourcesDir(executablePath!), 'app.asar')
  // Electron's node reads into an asar as if it were a folder.
  const script = `
    const fs = require('node:fs')
    const base = process.argv[1] + '/node_modules/@anthropic-ai/'
    const platformPackages = fs.readdirSync(base).filter((n) => n.startsWith('claude-agent-sdk-'))
    console.log(JSON.stringify({ sdk: fs.existsSync(base + 'claude-agent-sdk/sdk.mjs'), platformPackages }))
  `
  const out = execFileSync(executablePath!, ['--input-type=commonjs', '-e', script, asar], {
    env: { ...cleanEnv(), ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    windowsHide: true
  })
  expect(JSON.parse(out.trim().split('\n').pop()!)).toEqual({ sdk: true, platformPackages: [] })
  expect(fs.existsSync(path.join(resourcesDir(executablePath!), 'app.asar.unpacked', 'node_modules', '@anthropic-ai'))).toBe(false)
})

test('the packaged app runs a scripted agent through a ticket', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'initial')

    app = await electron.launch({
      executablePath,
      args: [],
      cwd: root,
      env: {
        ...cleanEnv(),
        MAINBUS_HOME: path.join(tmp, 'home'),
        MAINBUS_RUNTIME: `fake:${path.join(root, 'e2e', 'fixtures', 'handoff.json')}`,
        MAINBUS_TEST_REPO: repo
      }
    })
    const page = await app.firstWindow()
    await addWorkspace(page)

    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Add hello file')
    await page.getByLabel('In your words').fill('Add hello.txt')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('button', { name: /Add hello file/ }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()

    // The scripted Planner hands off, and the Implementer starts.
    await expect(page.getByText('Planner → Implementer', { exact: true })).toBeVisible({ timeout: 30_000 })
  } finally {
    if (app) await killApp(app).catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})
