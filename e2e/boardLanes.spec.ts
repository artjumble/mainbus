/// <reference lib="dom" />
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createTicket, expectFullHeightLanes, laneLayout, makeRepo } from './artboardHelpers'

/**
 * The board's lanes are at least the full height of the board area, grow with their cards (the page scrolls, not the
 * lane), and take a drop anywhere in them. FakeRuntime, a temporary MAINBUS_HOME and a throwaway repo; never the
 * user's board or data home.
 */

const root = path.resolve(import.meta.dirname, '..')
const column = (page: Page, name: string) => page.getByRole('region', { name, exact: true })

async function withBoard(size: { width: number; height: number }, body: (page: Page) => Promise<void>): Promise<void> {
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
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, h!), [size.width, size.height])
    await page.getByRole('button', { name: 'Add workspace' }).click()
    await body(page)
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
}

test('a card dropped in the empty space at the bottom of a full-height lane moves to that lane', async () => {
  await withBoard({ width: 1440, height: 960 }, async (page) => {
    await createTicket(page, { title: 'Drop me low' })
    const card = column(page, 'Backlog').getByRole('button', { name: /Drop me low/ })
    await expect(card).toBeVisible()
    // The dialog gone, and the columns still (they move as the panel settles), before pressing the card.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    let last: string | undefined
    await expect
      .poll(async () => {
        const box = JSON.stringify(await column(page, 'Ready').boundingBox())
        const still = box === last
        last = box
        return still
      })
      .toBe(true)
    const { board } = await expectFullHeightLanes(page)

    // Near the lane's bottom, far below anything in it (Ready has only its placeholder).
    const ready = (await column(page, 'Ready').boundingBox())!
    const placeholder = (await column(page, 'Ready').getByText('Nothing here').boundingBox())!
    const from = (await card.boundingBox())!
    const to = { x: ready.x + ready.width / 2, y: board.bottom - 20 }
    expect(to.y).toBeGreaterThan(placeholder.y + placeholder.height + 300)
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2, { steps: 5 })
    await page.mouse.move(to.x, to.y, { steps: 15 })
    await page.screenshot({ path: test.info().outputPath('dragging-low.png') })
    // Highlighted while the card is over it.
    await expect(column(page, 'Ready')).toHaveCSS('background-color', await laneTint(page, '--mantine-color-working-0'))
    await page.mouse.up()
    await expect(column(page, 'Ready').getByRole('button', { name: /Drop me low/ })).toBeVisible()
    await expect(column(page, 'Backlog').getByRole('button', { name: /Drop me low/ })).toHaveCount(0)
    await expect(column(page, 'Ready')).toHaveCSS('background-color', await laneTint(page, '--mainbus-color-lane'))
  })
})

test('a lane with more cards than fit is taller than the window, every lane with it, and the page scrolls, not the lane', async () => {
  await withBoard({ width: 1440, height: 640 }, async (page) => {
    for (let i = 1; i <= 6; i++) await createTicket(page, { title: `Card number ${i}` })
    await expect(column(page, 'Backlog').getByTestId('column-count')).toHaveText('6')
    const layout = await expectFullHeightLanes(page)
    expect(layout.board.bottom).toBeGreaterThan(layout.areaBottom + 50)
    const scroll = await page.evaluate(() => {
      const backlog = document.getElementById('column-backlog')!.closest('section')!
      const doc = document.scrollingElement!
      return { lane: backlog.scrollHeight - backlog.clientHeight, page: doc.scrollHeight - doc.clientHeight }
    })
    expect(scroll.lane).toBeLessThanOrEqual(1)
    expect(scroll.page).toBeGreaterThan(50)
    // Scrolled to the bottom, the last card shows, and the lanes still run to the board's bottom.
    const last = column(page, 'Backlog').getByRole('button', { name: /Card number/ }).last()
    await last.scrollIntoViewIfNeeded()
    await expect(last).toBeInViewport()
    const after = await laneLayout(page)
    for (const lane of after.lanes) expect(lane.bottom).toBeCloseTo(after.board.bottom, 0)
  })
})

/** The colour a CSS variable resolves to, as getComputedStyle reports a background. */
function laneTint(page: Page, variable: string): Promise<string> {
  return page.evaluate((v) => {
    const probe = document.createElement('div')
    probe.style.backgroundColor = `var(${v})`
    document.body.appendChild(probe)
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  }, variable)
}
