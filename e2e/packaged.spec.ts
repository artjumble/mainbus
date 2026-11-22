import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { addWorkspace } from './addWorkspace'
import { killApp } from './killApp'

// Runs against a packaged build, not out/. Set MAINBUS_E2E_PACKAGED to the packaged executable
// (dist/win-unpacked/Mainbus.exe, dist/mac-arm64/Mainbus.app/Contents/MacOS/Mainbus, the deb's /opt/Mainbus/mainbus-app,
// or an AppImage). Skipped otherwise.
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
  test.skip(executablePath!.endsWith('.AppImage'), "an AppImage's resources are inside its mount")
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

type App = Awaited<ReturnType<typeof electron.launch>>

/** Starts the packaged app on a throwaway repo with the scripted agent and a temporary data home, then runs `body`. */
async function withApp(body: (app: App, ctx: { repo: string; home: string }) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  let app: App | undefined
  try {
    const repo = path.join(tmp, 'repo')
    const home = path.join(tmp, 'home')
    fs.mkdirSync(repo)
    git(repo, 'init', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'initial')

    app = await electron.launch({
      executablePath,
      args: [],
      cwd: root,
      // Playwright adds --no-sandbox on Linux unless told not to. The packaged app must run with its sandbox.
      chromiumSandbox: true,
      env: {
        ...cleanEnv(),
        MAINBUS_HOME: home,
        MAINBUS_RUNTIME: `fake:${path.join(root, 'e2e', 'fixtures', 'handoff.json')}`,
        MAINBUS_TEST_REPO: repo
      }
    })
    await body(app, { repo, home })
  } finally {
    if (app) await killApp(app).catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
}

test('the packaged app runs a scripted agent through a ticket', async () => {
  await withApp(async (app) => {
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
  })
})

test('the renderer runs in the Chromium sandbox', async () => {
  test.skip(process.platform !== 'linux', 'checks /proc')
  await withApp(async (app) => {
    await app.firstWindow()
    expect(await app.evaluate(({ app: a }) => a.commandLine.hasSwitch('no-sandbox'))).toBe(false)
    const pid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId())
    // Seccomp mode 2 is the filter the sandbox installs on the renderer.
    expect(fs.readFileSync(`/proc/${pid}/status`, 'utf8')).toMatch(/^Seccomp:\t2$/m)
  })
})

// MAINBUS_E2E_CLI names the installed CLI command (found on PATH, as a terminal finds it).
test('the mainbus CLI files a ticket on the running app from a terminal', async () => {
  const cli = process.env['MAINBUS_E2E_CLI']
  test.skip(!cli, 'set MAINBUS_E2E_CLI to the installed mainbus command')
  await withApp(async (app, { repo, home }) => {
    const page = await app.firstWindow()
    await addWorkspace(page)
    const env = { ...cleanEnv(), MAINBUS_HOME: home }
    execFileSync(cli!, ['ticket', 'create', '--title', 'From the terminal', '--intent', 'Filed by the CLI'], {
      cwd: repo,
      env,
      stdio: 'pipe'
    })
    const listed = execFileSync(cli!, ['ticket', 'list', '--json'], { cwd: repo, env, encoding: 'utf8' })
    expect(JSON.parse(listed).map((t: { title: string }) => t.title)).toContain('From the terminal')
    await expect(page.getByRole('button', { name: /From the terminal/ })).toBeVisible({ timeout: 15_000 })
  })
})
