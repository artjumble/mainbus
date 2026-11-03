/// <reference lib="dom" />
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '..')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Mainbus E2E', '-c', 'user.email=e2e@mainbus.test', ...args], {
    cwd,
    windowsHide: true,
    stdio: 'pipe'
  })
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
      MAINBUS_RUNTIME: 'fake:e2e/fixtures/ask-then-handoff-by-role.json',
      MAINBUS_TEST_REPO: repo
    }
  })
  return { app, page: await app.firstWindow() }
}

/** Whether the focused element shows a focus indicator: an outline, or for a text field its border colour. */
async function expectFocusRing(page: Page): Promise<void> {
  // Mantine eases a text field's border colour in, so give the ring a moment.
  await expect.poll(() => focusRing(page), { message: 'the focused element shows a ring' }).toBe('ok')
}

async function focusRing(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return 'nothing is focused'
    if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox')) {
      // Mantine draws a radio's or checkbox's ring on the input itself.
      return getComputedStyle(el).outlineStyle !== 'none' ? 'ok' : 'a radio or checkbox without an outline'
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      // Mantine shows focus in a text field as the primary colour (working blue) on its border.
      const style = getComputedStyle(el)
      return style.outlineStyle !== 'none' || style.borderColor === 'rgb(30, 63, 153)' ? 'ok' : `a text field with a ${style.borderColor} border`
    }
    return getComputedStyle(el).outlineStyle !== 'none' ? 'ok' : `${el.tagName} without an outline`
  })
}

const isFocused = (locator: Locator): Promise<boolean> => locator.evaluate((el) => el === document.activeElement)

/** Presses Tab until `locator` has focus, as a person without a mouse would, then checks it shows a focus ring. */
async function tabTo(page: Page, locator: Locator, max = 80): Promise<void> {
  await expect(locator).toBeVisible()
  for (let i = 0; i < max; i++) {
    if (await isFocused(locator).catch(() => false)) {
      await expectFocusRing(page)
      return
    }
    await page.keyboard.press('Tab')
  }
  throw new Error(`Tab never reached ${locator}`)
}

/** Tabs to the button and presses Enter. */
async function activate(page: Page, locator: Locator): Promise<void> {
  await tabTo(page, locator)
  await page.keyboard.press('Enter')
}

async function createTicket(page: Page, title: string, words: string, opener: Locator): Promise<void> {
  await activate(page, opener)
  await expect(page.getByRole('dialog', { name: 'New ticket' })).toBeVisible()
  await tabTo(page, page.getByLabel('Title'))
  await page.keyboard.type(title)
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('In your words')).toBeFocused()
  await page.keyboard.type(words)
  await activate(page, page.getByRole('button', { name: 'Create' }))
  await expect(page.getByRole('dialog', { name: 'New ticket' })).toBeHidden()
}

/** A temporary home and a throwaway repo, with Mainbus launched on them; cleaned up afterwards. */
async function withSession(body: (page: Page) => Promise<void>): Promise<void> {
  let tmp: string | null = null
  let session: { app: ElectronApplication; page: Page } | null = null
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-e2e-'))
    const home = path.join(tmp, 'home')
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init')
    fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'initial')
    session = await launch(home, repo)
    await body(session.page)
  } finally {
    await session?.app.close().catch(() => {})
    // Cleanup must never hide the test's own failure.
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // A temp folder left behind is harmless.
      }
    }
  }
}

test('the core flow works by keyboard alone: create, start, answer, move', async () => {
  await withSession(async (page) => {
    // Open the repo (the hook skips the folder dialog).
    await activate(page, page.getByRole('button', { name: 'Add workspace' }))

    // The first ticket, from the empty state.
    await createTicket(page, 'Add hello file', 'Add hello.txt', page.getByRole('button', { name: 'New ticket' }))
    await expect(page.getByRole('region', { name: 'Backlog' }).getByText('Add hello file')).toBeVisible()

    // Esc closes the dialog and focus is back on what opened it.
    const headerNew = page.getByRole('button', { name: 'New ticket' })
    await activate(page, headerNew)
    await expect(page.getByRole('dialog', { name: 'New ticket' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'New ticket' })).toBeHidden()
    await expect(headerNew).toBeFocused()

    // The second ticket.
    await createTicket(page, 'Second ticket', 'Another one', headerNew)
    await expect(page.getByRole('region', { name: 'Backlog' }).getByText('Second ticket')).toBeVisible()

    // Move the second card from Backlog to Ready: Space picks it up, Arrow Right moves it a column, Space drops it.
    const second = page.getByRole('button', { name: /Move ticket #2/ })
    await tabTo(page, second)
    // Each step is announced for screen readers; waiting for that also gives dnd-kit time to take the next key.
    const announced = page.locator('[id^="DndLiveRegion"]')
    await page.keyboard.press('Space')
    await expect(announced).toContainText('Picked up ticket #2 Second ticket')
    // dnd-kit starts listening for the next key a moment after it announces the pick-up.
    await page.waitForTimeout(200)
    await page.keyboard.press('ArrowRight')
    await expect(announced).toContainText('ticket #2 Second ticket is over Ready')
    await page.keyboard.press('Space')
    await expect(announced).toContainText('ticket #2 Second ticket was dropped on Ready')
    await expect(page.getByRole('region', { name: 'Ready' }).getByText('Second ticket')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Backlog' }).getByText('Second ticket')).toHaveCount(0)

    // Open the first ticket from its title, and send the first message, which starts the lineup.
    await activate(page, page.getByRole('button', { name: /Add hello file/ }))
    await tabTo(page, page.getByRole('textbox', { name: 'First message (starts the lineup)' }))
    await page.keyboard.type('Please add hello.txt')
    await activate(page, page.getByRole('main').getByRole('button', { name: 'Send' }))
    await expect(page.getByRole('heading', { name: 'Add hello file' })).toBeVisible()
    await expect(page.getByText('Looking at the repo before I add hello.txt.')).toBeVisible()
    await expect(page.getByLabel('Message the Implementer')).toHaveValue('')

    // The second message lets the Implementer go on to ask its question.
    await tabTo(page, page.getByLabel('Message the Implementer'))
    await page.keyboard.type('Go ahead')
    await activate(page, page.getByRole('main').getByRole('button', { name: 'Send' }))

    // Answer the question: Tab reaches the options, the arrow keys choose, Tab reaches Answer.
    const question = page.locator('[data-event="decision"]')
    await expect(question).toBeVisible()
    await tabTo(page, question.getByRole('radio').first())
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    await expect(question.getByRole('radio').first()).toBeChecked()
    await activate(page, question.getByRole('button', { name: 'Answer' }))

    // Allow the permission.
    const permission = page.locator('[data-event="permission"]')
    await expect(permission).toBeVisible()
    await activate(page, permission.getByRole('button', { name: 'Always allow in this workspace' }))
    await expect(page.getByText('Ready for review', { exact: true })).toBeVisible()

    // Back to the board by keyboard; the card is in Review.
    await activate(page, page.getByRole('button', { name: /board/ }))
    await expect(page.getByRole('region', { name: 'Review' }).getByText('Add hello file')).toBeVisible()
  })
})

test('Tab follows the layout: rail, then the board header and board, then the orchestrator panel', async () => {
  await withSession(async (page) => {
    await activate(page, page.getByRole('button', { name: 'Add workspace' }))
    await createTicket(page, 'Order me', 'words', page.getByRole('button', { name: 'New ticket' }))
    await expect(page.getByRole('button', { name: /Order me/ })).toBeVisible()

    // Walk the whole tab cycle once, noting where each stop sits.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    const stops: { landmark: string; label: string }[] = []
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab')
      const stop = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement
        const landmark = el.closest('nav, header, main, aside')?.tagName.toLowerCase() ?? 'none'
        const label = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? el.tagName
        return { landmark, label }
      })
      if (stops.length > 0 && stop.label === stops[0]!.label && stop.landmark === stops[0]!.landmark) break
      stops.push(stop)
    }
    const rank: Record<string, number> = { nav: 0, header: 1, main: 2, aside: 3 }
    // The cycle starts wherever focus was; read it from the rail, its first stop.
    const start = stops.findIndex((s) => s.landmark === 'nav')
    stops.push(...stops.splice(0, start))
    const ranks = stops.map((s) => rank[s.landmark] ?? -1)
    expect(ranks, JSON.stringify(stops)).not.toContain(-1)
    expect(ranks, `going back in ${JSON.stringify(stops)}`).toEqual([...ranks].sort((a, b) => a - b))
    // All three regions are on the way, and in the board the search box comes before the cards.
    expect(new Set(ranks)).toEqual(new Set([0, 2, 3]))
    const labels = stops.map((s) => s.label)
    expect(labels.indexOf('Search tickets')).toBeLessThan(labels.findIndex((l) => l.startsWith('Move ticket')))
  })
})
