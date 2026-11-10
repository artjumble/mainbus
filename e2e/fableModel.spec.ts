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
    env: {
      ...env,
      MAINBUS_HOME: home,
      // The Planner fails if it runs; the Implementer fails unless it runs on Fable 5.2 at medium effort. The fake's
      // model list is shaped like the real one: the `fable` alias still names 5.1, and 5.2 is listed by id.
      MAINBUS_RUNTIME: 'fake:e2e/fixtures/fable-implementer-by-role.json',
      MAINBUS_TEST_REPO: repo
    }
  })
  return { app, page: await app.firstWindow() }
}

test('the Implementer set to Fable in Run settings runs on the latest Fable when the ticket starts', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-fable-'))
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

    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Add hello file')
    await page.getByLabel('In your words').fill('Add hello.txt')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('region', { name: 'Backlog' }).getByText('Add hello file').click()

    // Run settings offer Fable beside Opus, Sonnet and Haiku, each with its version.
    await page.getByRole('button', { name: 'Run settings…' }).click()
    const settings = page.getByRole('dialog', { name: 'Run settings' })
    await settings.getByRole('checkbox', { name: '1. Planner' }).uncheck()
    await settings.getByRole('button', { name: /Models and effort per role/ }).click()
    const model = settings.getByRole('combobox', { name: 'Model for Implementer' })
    await expect(model.locator('option')).toHaveText(['Fable 5.2', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'])
    await model.selectOption('Fable 5.2')
    await settings.getByRole('button', { name: 'Save' }).click()
    await expect(settings).toHaveCount(0)

    // Started, the fake runtime receives Fable 5.2 for the Implementer; anything else ends its run with an error.
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByText('Implementer running on Fable.')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/The launch has model/)).toHaveCount(0)
    await expect(page.getByText('The Planner ran')).toHaveCount(0)

    // It goes through to Review.
    await page.getByRole('button', { name: /board$/ }).click()
    await expect(page.getByRole('region', { name: 'Review' }).getByText('Add hello file')).toBeVisible({ timeout: 30_000 })
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
