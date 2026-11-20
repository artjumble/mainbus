/// <reference lib="dom" />
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { addWorkspace } from './addWorkspace'
import { createTicket, makeRepo } from './artboardHelpers'

/**
 * While the board scrolls in its area, the header (search, Unattended, New ticket) and the column titles stay at the
 * top, and a card scrolled into view isn't under them. FakeRuntime, a temporary MAINBUS_HOME and a throwaway repo.
 */

const root = path.resolve(import.meta.dirname, '..')
const column = (page: Page, name: string) => page.getByRole('region', { name, exact: true })

test('the header and the column titles stay at the top while the board scrolls, and a focused card is not under them', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  let app: ElectronApplication | undefined
  try {
    const repo = makeRepo(tmp, 'repo')
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env['ELECTRON_RUN_AS_NODE']
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: {
        ...env,
        MAINBUS_HOME: path.join(tmp, 'home'),
        MAINBUS_RUNTIME: 'fake:e2e/fixtures/needs-you-column-by-role.json',
        MAINBUS_TEST_REPO: repo
      }
    })
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 640))
    await addWorkspace(page)
    for (let i = 1; i <= 8; i++) await createTicket(page, { title: `Sticky card ${i}` })
    await expect(column(page, 'Backlog').getByTestId('column-count')).toHaveText('8')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    const scroller = page.getByTestId('main-scroll')
    const header = page.getByTestId('board-header')
    const title = column(page, 'Backlog').getByRole('heading', { name: 'Backlog' })
    const done = column(page, 'Done').getByRole('heading', { name: 'Done' })
    await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(100)

    // Scrolled to the bottom: the header is at the top of the area, the titles right under it.
    const area = (await scroller.boundingBox())!
    const h = (await header.boundingBox())!
    expect(h.y).toBeLessThanOrEqual(area.y + 1)
    await expect(page.getByRole('textbox', { name: 'Search tickets' })).toBeInViewport()
    await expect(page.getByRole('button', { name: 'New ticket' })).toBeInViewport()
    const t = (await title.boundingBox())!
    expect(t.y).toBeGreaterThanOrEqual(h.y + h.height - 1)
    expect(t.y).toBeLessThan(h.y + h.height + 40)
    await expect(done).toBeInViewport()
    expect((await done.boundingBox())!.y).toBeLessThan(h.y + h.height + 120)

    // The cards scroll under the titles, and are opaque-covered by them, not over them.
    const top = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('section')?.getAttribute('aria-labelledby'),
      { x: t.x + 4, y: t.y + t.height / 2 }
    )
    expect(top).toBe('column-backlog')

    // A card focused from above stops below the header and the title.
    await scroller.evaluate((el) => el.scrollTo(0, 0))
    const first = column(page, 'Backlog').getByRole('button', { name: /Sticky card 1/ })
    await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await first.focus()
    await expect(first).toBeInViewport()
    const cardBox = (await first.boundingBox())!
    const titleBox = (await title.boundingBox())!
    expect(cardBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height - 1)

    // Dragging a card near the top, with the headers stuck, still moves it.
    await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight))
    const last = column(page, 'Backlog').getByRole('button', { name: /Sticky card 8/ })
    const from = (await last.boundingBox())!
    const ready = (await column(page, 'Ready').boundingBox())!
    const hh = (await header.boundingBox())!
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2, { steps: 5 })
    await page.mouse.move(ready.x + ready.width / 2, hh.y + hh.height + 80, { steps: 15 })
    await page.mouse.up()
    await expect(column(page, 'Ready').getByRole('button', { name: /Sticky card 8/ })).toBeVisible()
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})
