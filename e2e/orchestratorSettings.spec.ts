import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { addWorkspace } from './addWorkspace'

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
    env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/orchestrator-settings.json', MAINBUS_TEST_REPO: repo }
  })
  return { app, page: await app.firstWindow() }
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Mainbus settings' }).click()
  await expect(page.getByRole('dialog', { name: 'Mainbus settings' }).getByRole('region', { name: 'Orchestrator', exact: true })).toBeVisible()
}

const webSwitch = (page: Page) =>
  page.getByRole('dialog', { name: 'Mainbus settings' }).getByRole('switch', { name: /^Let the orchestrator read web pages/ })

test('the orchestrator settings: switching to Sonnet at high effort applies from its next turn; the web access setting turns off; both are remembered; web tool calls are summarised in the panel', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-orchestrator-model-'))
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
    await addWorkspace(page)

    // The panel shows what the next turn runs with: Opus at medium effort until the user chooses.
    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    await expect(panel.getByText('Opus 5.5 · Medium effort')).toBeVisible()
    const box = panel.getByRole('textbox', { name: 'Message the orchestrator' })
    await box.fill('Hello')
    await box.press('Enter')
    await expect(panel.getByText('First reply, on Opus at medium effort.')).toBeVisible()
    // The scripted turn only emits the web tool calls as events: nothing touches the network.
    await expect(panel.getByRole('button', { name: /Read docs.waveshare.com, searched the web/ })).toBeVisible()

    // The Orchestrator section offers the latest of each family, with versions, and every effort.
    await openSettings(page)
    const section = page.getByRole('dialog', { name: 'Mainbus settings' }).getByRole('region', { name: 'Orchestrator', exact: true })
    const model = section.getByRole('combobox', { name: 'Model' })
    const effort = section.getByRole('combobox', { name: 'Effort' })
    await expect(model).toBeEnabled()
    await expect(model.locator('option')).toHaveText(['Fable 5.2', 'Opus 5.5', 'Sonnet 5.5'])
    await expect(model).toHaveValue('opus')
    await expect(effort.locator('option')).toHaveText(['Low', 'Medium', 'High', 'Xhigh', 'Max'])
    await expect(effort).toHaveValue('medium')
    await expect(section.getByText('Higher effort and larger models make each orchestrator turn slower and use more of your plan.')).toBeVisible()
    await expect(webSwitch(page)).toBeEnabled()
    await expect(webSwitch(page)).toBeChecked()
    await webSwitch(page).uncheck()
    await expect(webSwitch(page)).not.toBeChecked()
    await model.selectOption('sonnet')
    await effort.selectOption('high')
    await page.keyboard.press('Escape')
    await expect(panel.getByText('Sonnet 5.5 · High effort')).toBeVisible()
    await openSettings(page)
    await expect(webSwitch(page)).toBeEnabled()
    await expect(webSwitch(page)).not.toBeChecked()
    await page.keyboard.press('Escape')

    // The fake runtime checks the model and effort of the turn; a mismatch would end its run with an error.
    await box.fill('And now?')
    await box.press('Enter')
    await expect(panel.getByText('Second reply, on Sonnet at high effort, in the same conversation.')).toBeVisible()
    await expect(panel.getByText(/The launch has model/)).toHaveCount(0)
    await expect(panel.getByText('First reply, on Opus at medium effort.')).toBeVisible()

    // Remembered across a restart.
    await app.close()
    app = undefined
    ;({ app, page } = await launch(home, repo))
    await expect(page.getByRole('complementary', { name: 'Orchestrator' }).getByText('Sonnet 5.5 · High effort')).toBeVisible()
    await openSettings(page)
    await expect(webSwitch(page)).toBeEnabled()
    await expect(webSwitch(page)).not.toBeChecked()
    await page.keyboard.press('Escape')
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
