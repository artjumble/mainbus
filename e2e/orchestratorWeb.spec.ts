import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '..')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Mainbus E2E', '-c', 'user.email=e2e@mainbus.test', ...args], { cwd, windowsHide: true, stdio: 'pipe' })
}

async function launch(home: string, repo: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/orchestrator-web.json', MAINBUS_TEST_REPO: repo }
  })
  return { app, page: await app.firstWindow() }
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Mainbus settings' }).click()
  await expect(page.getByRole('dialog', { name: 'Mainbus settings' }).getByRole('region', { name: 'Orchestrator', exact: true })).toBeVisible()
}

const webSwitch = (page: Page) =>
  page.getByRole('dialog', { name: 'Mainbus settings' }).getByRole('switch', { name: /^Let the orchestrator read web pages/ })

test('the web access setting is on, turns off and is remembered; web tool calls are summarised in the panel', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-web-'))
  let app: ElectronApplication | undefined
  try {
    const home = path.join(tmp, 'home')
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'initial')

    let page: Page
    ;({ app, page } = await launch(home, repo))
    await page.getByRole('button', { name: 'Add workspace' }).click()
    await page.getByRole('navigation', { name: 'Workspaces' }).waitFor()

    await openSettings(page)
    await expect(webSwitch(page)).toBeEnabled()
    await expect(webSwitch(page)).toBeChecked()
    await webSwitch(page).uncheck()
    await expect(webSwitch(page)).not.toBeChecked()
    await page.keyboard.press('Escape')
    await openSettings(page)
    await expect(webSwitch(page)).toBeEnabled()
    await expect(webSwitch(page)).not.toBeChecked()

    // Remembered across a restart.
    await app.close()
    app = undefined
    ;({ app, page } = await launch(home, repo))
    await page.getByRole('navigation', { name: 'Workspaces' }).waitFor()
    await openSettings(page)
    await expect(webSwitch(page)).toBeEnabled()
    await expect(webSwitch(page)).not.toBeChecked()
    await page.keyboard.press('Escape')

    // The scripted turn only emits the tool calls as events: nothing touches the network.
    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    const box = panel.getByRole('textbox', { name: 'Message the orchestrator' })
    await box.fill('Read the Waveshare docs')
    await box.press('Enter')
    await expect(panel.getByText('I read the Waveshare page.')).toBeVisible()
    await expect(panel.getByRole('button', { name: /Read docs\.waveshare\.com, searched the web/ })).toBeVisible()
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
