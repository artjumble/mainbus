import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * The Done column is a narrow strip that opens over Review on hover, on focus and while a card is dragged over it.
 * FakeRuntime, a temporary MAINBUS_HOME and a throwaway repo; never the user's board or data home.
 */

const root = path.resolve(import.meta.dirname, '..')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Mainbus E2E', '-c', 'user.email=e2e@mainbus.test', ...args], {
    cwd,
    windowsHide: true,
    stdio: 'pipe'
  })
}

/** Runs `body` against the app on a fresh temp home and repo, with every role handing off at once, at board size. */
async function withBoard(body: (page: Page, home: string) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
  let app: ElectronApplication | undefined
  try {
    const home = path.join(tmp, 'home')
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'initial')
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env['ELECTRON_RUN_AS_NODE']
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/handoff.json', MAINBUS_TEST_REPO: repo }
    })
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 960))
    await page.getByRole('button', { name: 'Add workspace' }).click()
    await body(page, home)
  } finally {
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** Creates a ticket and starts it; each role hands off at once, so it lands in Review, with its worktree. */
async function ticketInReview(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New ticket' }).click()
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('In your words').fill(`Words for ${title}`)
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: new RegExp(title) }).click()
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByText('Ready for review', { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /board/ }).click()
  await expect(page.getByRole('region', { name: 'Review', exact: true }).getByText(title)).toBeVisible()
}

/** The ticket worktrees under the data home's `work` folder, one folder per workspace. */
function worktrees(home: string): string[] {
  const work = path.join(home, 'work')
  if (!fs.existsSync(work)) return []
  return fs.readdirSync(work).flatMap((ws) => fs.readdirSync(path.join(work, ws)).map((t) => path.join(ws, t)))
}

const done = (page: Page) => page.getByRole('region', { name: 'Done', exact: true })
const review = (page: Page) => page.getByRole('region', { name: 'Review', exact: true })
const width = async (page: Page): Promise<number> => (await done(page).boundingBox())!.width

test('a Review card dragged onto the closed Done strip opens it over Review and lands in Done, cleaned up', async () => {
  await withBoard(async (page, home) => {
    await ticketInReview(page, 'Ship it')
    expect(worktrees(home)).toHaveLength(1)
    await expect(done(page)).toHaveAttribute('data-expanded', 'false')
    expect(await width(page)).toBeLessThan(60)
    const reviewBox = (await review(page).boundingBox())!

    // Press the card and drag it, in steps, onto the strip.
    const card = (await review(page).getByRole('button', { name: /Ship it/ }).boundingBox())!
    const strip = (await done(page).boundingBox())!
    await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2)
    await page.mouse.down()
    await page.mouse.move(card.x + card.width / 2 + 20, card.y + card.height / 2, { steps: 5 })
    await page.mouse.move(strip.x + strip.width / 2, card.y + card.height / 2, { steps: 15 })

    // Done opens over Review; Review doesn't move or change size.
    await expect(done(page)).toHaveAttribute('data-expanded', 'true')
    await expect.poll(() => width(page)).toBeGreaterThan(100)
    // Done, open, is as wide as the other columns.
    await expect.poll(() => width(page)).toBeCloseTo(reviewBox.width, 0)
    expect(await review(page).boundingBox()).toEqual(reviewBox)
    // For a look: the dragged card stays above Done open over Review.
    await page.screenshot({ path: test.info().outputPath('dragging-over-done.png') })

    // Released over the left part of Done, where Review is underneath.
    const open = (await done(page).boundingBox())!
    expect(open.x).toBeLessThan(reviewBox.x + reviewBox.width)
    await page.mouse.move(open.x + 40, card.y + card.height / 2, { steps: 5 })
    await page.mouse.up()

    await expect(done(page).getByText('Ship it')).toBeVisible()
    await expect(review(page).getByText('Ship it')).toHaveCount(0)
    await expect(page.getByText('Cleaning up…')).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(() => worktrees(home)).toEqual([])

    // Once the pointer goes, Done closes and its cards are hidden.
    await page.mouse.move(5, 5)
    await expect(done(page)).toHaveAttribute('data-expanded', 'false')
    await expect(done(page).getByText('Ship it')).toBeHidden()
    await expect.poll(() => width(page)).toBeLessThan(60)
    await expect(done(page).getByTestId('column-count')).toHaveText('1')
  })
})

test('the same move by keyboard: Space, Arrow Right onto the strip, Space', async () => {
  await withBoard(async (page, home) => {
    await ticketInReview(page, 'Ship it')
    await expect(done(page)).toHaveAttribute('data-expanded', 'false')
    const announced = page.locator('[id^="DndLiveRegion"]')
    await review(page).getByRole('button', { name: /^Move ticket #/ }).focus()
    await page.keyboard.press('Space')
    await expect(announced).toContainText('Picked up ticket #1 Ship it')
    // dnd-kit starts listening for the next key a moment after it announces the pick-up.
    await page.waitForTimeout(200)
    await page.keyboard.press('ArrowRight')
    await expect(announced).toContainText('ticket #1 Ship it is over Done')
    await expect(done(page)).toHaveAttribute('data-expanded', 'true')
    await page.keyboard.press('Space')
    await expect(announced).toContainText('ticket #1 Ship it was dropped on Done')

    await expect(done(page).getByText('Ship it')).toBeVisible()
    await expect(page.getByText('Cleaning up…')).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(() => worktrees(home)).toEqual([])
    // Focus is back on the card's handle, in Done, which stays open while it is there.
    await expect(done(page).getByRole('button', { name: 'Move ticket #1' })).toBeFocused()
    await page.waitForTimeout(500)
    await expect(done(page)).toHaveAttribute('data-expanded', 'true')
  })
})

test("hovering the strip shows Done's cards, and one can be opened", async () => {
  await withBoard(async (page) => {
    await ticketInReview(page, 'Ship it')
    await review(page).getByRole('button', { name: /Ship it/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to Done' }).click()
    await expect(review(page).getByText('Ship it')).toHaveCount(0)
    // Focus goes back to the card, which opens Done; clicking elsewhere and moving away closes it.
    await expect(done(page).getByRole('button', { name: /Ship it/ })).toBeFocused()
    await expect(done(page)).toHaveAttribute('data-expanded', 'true')
    await page.getByRole('main').getByRole('heading', { level: 2 }).click()
    await page.mouse.move(5, 5)
    await expect(done(page)).toHaveAttribute('data-expanded', 'false')
    await expect(done(page).getByText('Ship it')).toBeHidden()

    await done(page).hover()
    await expect(done(page).getByText('Ship it')).toBeVisible()
    await done(page).getByRole('button', { name: /Ship it/ }).click()
    await expect(page.getByRole('heading', { name: 'Ship it' })).toBeVisible()
  })
})
