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
  // The scripted fake runtime and a temporary home: never the user's real board.
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/keep-working.json', MAINBUS_TEST_REPO: repo }
  })
  return { app, page: await app.firstWindow() }
}

async function createReadyTicket(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New ticket' }).click()
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('In your words').fill(title)
  await page.getByLabel('Column').selectOption('ready')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('region', { name: 'Ready' }).getByText(title)).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

/** The titles of the Ready cards, top first. */
const readyOrder = (page: Page): Promise<string[]> =>
  page
    .getByRole('region', { name: 'Ready' })
    .locator('[data-ticket-id]')
    .evaluateAll((els) => els.map((el) => /Ticket [ABC]/.exec(el.textContent ?? '')?.[0] ?? ''))

test('a card dragged above another in Ready keeps its place after a reload, and unattended mode starts the top one', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  let session: { app: ElectronApplication; page: Page } | null = null
  try {
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'initial')

    session = await launch(path.join(tmp, 'home'), repo)
    const { page } = session
    await addWorkspace(page)
    for (const title of ['Ticket A', 'Ticket B', 'Ticket C']) await createReadyTicket(page, title)
    expect(await readyOrder(page)).toEqual(['Ticket A', 'Ticket B', 'Ticket C'])

    // Drag C above A, once the layout has stopped moving.
    const ready = page.getByRole('region', { name: 'Ready' })
    let last: string | undefined
    await expect
      .poll(async () => {
        const box = JSON.stringify(await ready.locator('[data-ticket-id]').nth(2).boundingBox())
        const still = box === last
        last = box
        return still
      })
      .toBe(true)
    const a = (await ready.locator('[data-ticket-id]').nth(0).boundingBox())!
    const c = (await ready.locator('[data-ticket-id]').nth(2).boundingBox())!
    await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2)
    await page.mouse.down()
    await page.mouse.move(c.x + c.width / 2 + 10, c.y + c.height / 2 - 10, { steps: 5 })
    await page.mouse.move(a.x + a.width / 2, a.y + 4, { steps: 15 })
    await expect(page.getByTestId('drop-indicator')).toBeVisible()
    await page.mouse.up()
    await expect.poll(() => readyOrder(page)).toEqual(['Ticket C', 'Ticket A', 'Ticket B'])

    await page.reload()
    await expect(ready.getByText('Ticket A')).toBeVisible()
    expect(await readyOrder(page)).toEqual(['Ticket C', 'Ticket A', 'Ticket B'])

    // Unattended mode starts the card at the top, and leaves the others in Ready.
    await page.getByRole('switch', { name: 'Unattended' }).check()
    await expect(page.getByRole('region', { name: 'In progress' }).getByText('Ticket C')).toBeVisible()
    await expect(ready.getByText('Ticket A')).toBeVisible()
    await expect(ready.getByText('Ticket B')).toBeVisible()
    await page.getByRole('switch', { name: 'Unattended' }).uncheck()
  } finally {
    await session?.app.close()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
