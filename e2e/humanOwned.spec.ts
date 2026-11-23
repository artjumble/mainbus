import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { addWorkspace } from './addWorkspace'
import { makeRepo } from './artboardHelpers'
import { expectNoAxeViolations } from './axe'

const root = path.resolve(import.meta.dirname, '..')

const invoke = <T = { id: string }>(page: Page, command: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(
    ([c, a]) =>
      (globalThis as unknown as { mainbus: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).mainbus.invoke(
        c as string,
        ...(a as unknown[])
      ) as Promise<T>,
    [command, args] as const
  )

test('a ticket of the user: the You badge and accent on the board, the "This ticket is yours" view, Mark done and Hand to agents', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  let app: ElectronApplication | undefined
  try {
    const home = path.join(tmp, 'home')
    const repo = makeRepo(tmp, 'web-app')
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env['ELECTRON_RUN_AS_NODE']
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/ask-then-handoff-by-role.json', MAINBUS_TEST_REPO: repo }
    })
    const page = await app.firstWindow()
    await addWorkspace(page)
    await expect(page.getByRole('button', { name: 'New ticket' })).toBeVisible()

    const make = (title: string): Promise<{ id: string }> =>
      invoke(page, 'ticket.create', { title, intent: title, spec: '', criteria: ['Draft', 'Proof'], labels: [], column: 'ready' })
    const mine = await make('Write the post')
    const other = await make('Publish the post')
    const agents = await make('Agent work')
    await invoke(page, 'ticket.setOwner', mine.id, 'human')
    await invoke(page, 'ticket.setOwner', other.id, 'human')

    // The board: badge, accent, name, no agent chips, in Ready only.
    const card = page.locator(`[data-ticket-card="${mine.id}"]`)
    await expect(card).toBeVisible()
    await expect(card.locator('[data-you-badge]')).toHaveText('You')
    await expect(card.getByRole('button', { name: /^#\d+, yours: Write the post$/ })).toBeVisible()
    await expect(card.locator('[data-phase-chip]')).toHaveCount(0)
    expect(await card.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe('4px')
    expect(await page.locator(`[data-ticket-card="${agents.id}"]`).evaluate((el) => parseFloat(getComputedStyle(el).borderLeftWidth))).toBeLessThan(2)
    await expect(page.getByRole('region', { name: 'Ready' }).locator(`[data-ticket-card="${mine.id}"]`)).toHaveCount(1)
    await expect(page.locator(`[data-ticket-card="${mine.id}"]`)).toHaveCount(1)
    await card.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Move to Backlog' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Move to In progress…' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expectNoAxeViolations(page, 'the board with a ticket of the user')

    // The view.
    await card.getByRole('button', { name: /yours: Write the post/ }).click()
    await expect(page.getByRole('heading', { name: 'This ticket is yours' })).toBeVisible()
    await expect(page.locator('[data-you-badge]')).toHaveCount(1)
    for (const name of ['Start', 'Start again', 'Run settings…', 'Send and start']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0)
    }
    const draft = page.getByRole('checkbox', { name: 'Draft' })
    await expect(draft).toHaveCount(1)
    await draft.check()
    await expect
      .poll(async () => {
        const board = await invoke<{ tickets: { id: string; criteria: { text: string; checked: boolean }[] }[] }>(page, 'board.get')
        return board.tickets.find((t) => t.id === mine.id)?.criteria.find((c) => c.text === 'Draft')?.checked
      })
      .toBe(true)
    await expectNoAxeViolations(page, 'the view of a ticket of the user')

    // Hand to agents: after the question, Start is there and the card has no badge.
    await page.getByRole('button', { name: 'Hand to agents' }).click()
    const dialog = page.getByRole('dialog', { name: /Hand #\d+ to agents\?/ })
    await dialog.getByRole('button', { name: 'Hand to agents' }).click()
    await expect(page.getByText('Nobody is working on this yet')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible()
    await page.getByRole('button', { name: /^← .* board$/ }).click()
    await expect(page.locator(`[data-ticket-card="${mine.id}"]`)).toBeVisible()
    await expect(page.locator(`[data-ticket-card="${mine.id}"] [data-you-badge]`)).toHaveCount(0)

    // Mark done on the other one moves it to Done.
    await page.locator(`[data-ticket-card="${other.id}"]`).getByRole('button', { name: /yours: Publish the post/ }).click()
    await page.getByRole('button', { name: 'Mark done' }).click()
    await expect
      .poll(async () => {
        const board = await invoke<{ tickets: { id: string; manualColumn: string }[] }>(page, 'board.get')
        return board.tickets.find((t) => t.id === other.id)?.manualColumn
      })
      .toBe('done')
  } finally {
    await app?.close()
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})
