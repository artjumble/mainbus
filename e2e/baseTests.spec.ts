import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

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

// The app runs with a fake agent in a throwaway repository and a temporary MAINBUS_HOME. The test command is the
// user's own small script, run by Mainbus for real in its baseline folder: it fails one named test.
test('the base branch tests record a failing test, and a started role is told it is a known failure', async () => {
  let tmp: string | null = null
  let app: ElectronApplication | null = null
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'initial')

    // Outside the repo: writes JUnit XML to the path it is given, with "math > divides" failing, and exits 1.
    const script = path.join(tmp, 'tests.cjs')
    fs.writeFileSync(
      script,
      [
        "const fs = require('node:fs')",
        'const xml =',
        "  '<testsuites><testsuite>' +",
        '  \'<testcase classname="math" name="adds"/>\' +',
        '  \'<testcase classname="math" name="divides"><failure message="1 is not 2"/></testcase>\' +',
        "  '</testsuite></testsuites>'",
        'fs.writeFileSync(process.argv[2], xml)',
        'process.exit(1)'
      ].join('\n')
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
        MAINBUS_RUNTIME: 'fake:e2e/fixtures/base-tests-known-failure.json',
        MAINBUS_TEST_REPO: repo
      }
    })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Add workspace' }).click()

    await page.getByRole('button', { name: 'Workspace settings' }).click()
    const section = page.getByRole('region', { name: 'Base branch tests' })
    await section.getByRole('button', { name: 'Add test command' }).click()
    await section.getByRole('textbox', { name: 'Test command 1 name' }).fill('Unit')
    await section.getByRole('textbox', { name: 'Test command 1 command' }).fill(`node "${script.replaceAll(path.sep, '/')}" <results>`)
    await section.getByRole('combobox', { name: 'Test command 1 result format' }).selectOption('junit-xml')
    await section.getByRole('button', { name: 'Save test commands' }).click()
    await expect(section.getByRole('button', { name: 'Save test commands' })).toBeDisabled()

    await section.getByRole('button', { name: 'Run base tests now' }).click()
    await expect(section.getByText('Unit: math > divides')).toBeVisible({ timeout: 60_000 })
    await expect(section.getByText('Unit: 1 failing', { exact: false })).toBeVisible()
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Check the known failure')
    await page.getByLabel('In your words').fill('Check the known failure')
    await page.getByLabel('Column').selectOption('ready')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('region', { name: 'Ready' }).getByText('Check the known failure').click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()

    // The fake agent's first step fails the run unless its system prompt lists the failure, so reaching Review proves it.
    await expect(page.getByText('Ready for review')).toBeVisible({ timeout: 30_000 })
  } finally {
    await app?.close().catch(() => {})
    cleanUp(tmp)
  }
})
