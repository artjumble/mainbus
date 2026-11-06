/// <reference lib="dom" />
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * The Needs you column is a narrow strip while no ticket is in it, and a full column while one is.
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

const column = (page: Page, name: string) => page.getByRole('region', { name, exact: true })
const needsYouStrip = (page: Page) => column(page, 'Needs you, no tickets')
const needsYou = (page: Page) => column(page, 'Needs you')
const width = async (page: Page, name: string): Promise<number> => (await column(page, name).boundingBox())!.width

/** Polls until a column's box stops changing, so a width transition has finished. */
async function settled(page: Page, name: string): Promise<void> {
  let last: string | undefined
  await expect
    .poll(async () => {
      const box = JSON.stringify(await column(page, name).boundingBox())
      const still = box === last
      last = box
      return still
    })
    .toBe(true)
}

/** Done, hovered, opens over Review to exactly the width of a full column; then it closes again. */
async function doneOpensToOneColumn(page: Page): Promise<void> {
  const review = (await column(page, 'Review').boundingBox())!
  await column(page, 'Done').hover()
  await expect(column(page, 'Done')).toHaveAttribute('data-expanded', 'true')
  await settled(page, 'Done')
  const done = (await column(page, 'Done').boundingBox())!
  expect(done.width).toBeCloseTo(review.width, 0)
  // Open over Review, which stays where it was, under Done.
  expect(done.x).toBeLessThan(review.x + review.width)
  expect(await column(page, 'Review').boundingBox()).toEqual(review)
  await page.mouse.move(5, 5)
  await expect(column(page, 'Done')).toHaveAttribute('data-expanded', 'false')
  await settled(page, 'Done')
}

/** Records Needs you's width on every frame, until it has changed and then held still for a while, to see how it changed. */
function sampleWidths(page: Page): Promise<number[]> {
  return page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const widths: number[] = []
        const start = performance.now()
        let changedAt: number | null = null
        const frame = (): void => {
          const now = performance.now()
          const w = document.getElementById('column-needs_you')?.closest('section')?.getBoundingClientRect().width
          if (w !== undefined) {
            if (widths.length > 0 && w !== widths[widths.length - 1]) changedAt = now
            widths.push(w)
          }
          const done = (changedAt !== null && now - changedAt > 300) || now - start > 20_000
          if (done) resolve(widths)
          else requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      })
  )
}

test('Needs you is a strip while nothing waits, opens with the card when a question arrives, and collapses once answered; Done opens to one column either way', async () => {
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
      env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: 'fake:e2e/fixtures/needs-you-column-by-role.json', MAINBUS_TEST_REPO: repo }
    })
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 960))
    await page.getByRole('button', { name: 'Add workspace' }).click()

    await page.getByRole('button', { name: 'New ticket' }).click()
    await page.getByLabel('Title').fill('Add hello file')
    await page.getByLabel('In your words').fill('Add hello.txt')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(column(page, 'Backlog').getByRole('button', { name: /Add hello file/ })).toBeVisible()

    // Nothing waits: Needs you is a strip, with its heading and a count of 0, and the four full columns share the rest.
    await expect(needsYouStrip(page)).toBeVisible()
    await expect(needsYouStrip(page).getByRole('heading', { name: 'Needs you' })).toBeVisible()
    await expect(needsYouStrip(page).getByTestId('column-count')).toHaveText('0')
    await settled(page, 'Backlog')
    expect(await width(page, 'Needs you, no tickets')).toBeLessThan(60)
    const fullWidths = await Promise.all(['Backlog', 'Ready', 'In progress', 'Review'].map((n) => width(page, n)))
    for (const w of fullWidths) expect(w).toBeCloseTo(fullWidths[0]!, 0)
    await page.screenshot({ path: test.info().outputPath('needs-you-collapsed.png') })
    await doneOpensToOneColumn(page)

    // Start it from the board, through the panel's proposal: the Planner asks at once, with the board on screen.
    await page.getByRole('button', { name: /Add hello file/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to In progress…' }).click()
    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    const proposal = panel.getByRole('group', { name: 'Proposal: Start #1 Add hello file' })
    const opening = sampleWidths(page)
    await proposal.getByRole('button', { name: 'Confirm', exact: true }).click()

    // The column opens, with the card. (No outline here: the question comes within the grace of the person's own
    // Confirm, which counts as their change; Board.test.tsx checks the outline on a card arriving in Needs you.)
    await expect(needsYou(page).getByText('Add hello file')).toBeVisible()
    await expect(needsYouStrip(page)).toHaveCount(0)
    const opened = await opening
    await settled(page, 'Needs you')
    const full = await width(page, 'Needs you')
    expect(full).toBeCloseTo(await width(page, 'Review'), 0)
    // It widened over a few frames, not in one step.
    expect(opened.some((w) => w > 60 && w < full - 10)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('needs-you-open.png') })
    await doneOpensToOneColumn(page)

    // Answered from the card: the ticket leaves, and the column collapses again.
    await needsYou(page).getByRole('button', { name: 'Answer' }).click()
    const popover = page.getByRole('dialog')
    await popover.getByRole('radio', { name: /docs folder/ }).check()
    await popover.getByRole('button', { name: 'Answer', exact: true }).click()
    await expect(column(page, 'In progress').getByText('Add hello file')).toBeVisible()
    await expect(needsYouStrip(page)).toBeVisible()
    await settled(page, 'Needs you, no tickets')
    expect(await width(page, 'Needs you, no tickets')).toBeLessThan(60)
    await doneOpensToOneColumn(page)
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
})
