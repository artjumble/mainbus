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

async function launch(home: string, repo: string, open: boolean): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/orchestrator-drafting.json', MAINBUS_TEST_REPO: repo }
  })
  const page = await app.firstWindow()
  if (open) await addWorkspace(page)
  return { app, page }
}

test('dragging the ticket view handle widens the left column; the width survives a relaunch', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  let app: ElectronApplication | undefined
  try {
    const repo = path.join(tmp, 'repo')
    const home = path.join(tmp, 'home')
    fs.mkdirSync(repo)
    git(repo, 'init', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'initial')

    let page: Page
    ;({ app, page } = await launch(home, repo, true))
    await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible()
    await page.evaluate(() =>
      (globalThis as unknown as { mainbus: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).mainbus.invoke('ticket.create', {
        title: 'Resizable ticket',
        intent: 'Make the column wider',
        spec: 'A spec to edit.',
        criteria: ['It widens'],
        labels: [],
        column: 'backlog'
      })
    )
    await page.getByText('Resizable ticket').first().click()
    const separator = page.getByRole('separator', { name: 'Resize ticket details' })
    await expect(separator).toHaveAttribute('aria-valuenow', '380')
    const details = page.locator('#ticket-details')
    expect((await details.boundingBox())!.width).toBeCloseTo(380, 0)

    const box = (await separator.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(44)
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 100, y, { steps: 10 })
    await expect(separator).toHaveAttribute('aria-valuenow', '480')
    await page.mouse.up()
    expect((await details.boundingBox())!.width).toBeCloseTo(480, 0)

    await app.close()
    app = undefined
    ;({ app, page } = await launch(home, repo, false))
    await page.getByText('Resizable ticket').first().click()
    await expect(page.getByRole('separator', { name: 'Resize ticket details' })).toHaveAttribute('aria-valuenow', '480')
    expect((await page.locator('#ticket-details').boundingBox())!.width).toBeCloseTo(480, 0)

    await page.getByRole('separator', { name: 'Resize ticket details' }).dblclick()
    await expect(page.getByRole('separator', { name: 'Resize ticket details' })).toHaveAttribute('aria-valuenow', '380')
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
