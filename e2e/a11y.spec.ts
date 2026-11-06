/// <reference lib="dom" />
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { themeOf } from '../src/shared/domain'
import { THEME_IDS, useTheme, type ThemeId } from './artboardHelpers'

const root = path.resolve(import.meta.dirname, '..')
const axeSource = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')

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

/** Runs axe over the page with every rule on, colour contrast included, and fails with what it found. */
// A 1×1 PNG.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** Pastes an image file onto `target`, as Ctrl+V with a screenshot on the clipboard does. */
async function pasteImage(target: Locator, name: string): Promise<void> {
  await target.evaluate(
    (el, { name, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], name, { type: 'image/png' }))
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    },
    { name, base64: PNG_BASE64 }
  )
}

async function expectNoAxeViolations(page: Page, what: string): Promise<void> {
  // Evaluated, not injected as a script tag, so the page's content security policy does not apply.
  await page.evaluate(axeSource)
  const violations = await page.evaluate(async () => {
    const results = await (window as unknown as { axe: { run: (c: Document) => Promise<{ violations: AxeViolation[] }> } }).axe.run(document)
    interface AxeViolation {
      id: string
      help: string
      nodes: { target: string[]; failureSummary?: string }[]
    }
    return results.violations.map((v) => ({
      id: v.id,
      help: v.help,
      nodes: v.nodes.map((n) => `${n.target.join(' ')}: ${n.failureSummary?.replace(/\s+/g, ' ').slice(0, 220) ?? ''}`)
    }))
  })
  expect(violations, `axe violations on ${what}`).toEqual([])
}

/**
 * Every visible control must be hit by a pointer within 21 px of its centre in each direction, i.e. have a 44 px
 * square target, unless it is a link inside a sentence. Returns what fails.
 */
async function smallTargets(page: Page, within = 'body'): Promise<string[]> {
  return page.evaluate((within) => {
    const selector =
      'button, a[href], [role="button"], [role="menuitem"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], input, select, textarea'
    const failures: string[] = []
    // An open menu or window covers the page behind it, so those are measured on their own.
    for (const el of Array.from(document.querySelector(within)!.querySelectorAll<HTMLElement>(selector))) {
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none' || el.closest('[aria-hidden="true"]')) continue
      if ((el as HTMLButtonElement).disabled) continue
      // A radio, checkbox or switch is pressed through its label (its own box is 20 px); measure the widest label.
      const labels = el instanceof HTMLInputElement && ['radio', 'checkbox'].includes(el.type) ? Array.from(el.labels ?? []) : []
      const box = labels.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] ?? el
      const r = box.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      // A link inside running text is exempt (WCAG 2.5.8 inline exception).
      if (el instanceof HTMLAnchorElement) {
        const parent = el.parentElement
        const own = (parent?.textContent ?? '').replace(el.textContent ?? '', '').trim()
        if (parent && own.length > 0 && getComputedStyle(parent).display !== 'flex') continue
      }
      const labelFor = (target: Element | null): boolean =>
        target !== null && ((el as HTMLInputElement).labels ? Array.from((el as HTMLInputElement).labels!).some((l) => l.contains(target)) : false)
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      // Scrolled out of view, clipped or covered at its centre (an open menu, say): not on screen to be pressed.
      const centre = document.elementFromPoint(cx, cy)
      if (centre === null || !(el.contains(centre) || labelFor(centre))) continue
      // Cut by a scroller that has content past this edge: its hit area is clipped by the scroller, not by its styling.
      const clipped = (): boolean => {
        for (let p = el.parentElement; p; p = p.parentElement) {
          const o = getComputedStyle(p)
          const scrolls = /(auto|scroll)/.test(o.overflowY + o.overflowX) && (p.scrollHeight > p.clientHeight || p.scrollWidth > p.clientWidth)
          if (!scrolls) continue
          const box = p.getBoundingClientRect()
          if (cy - 21 < box.top || cy + 21 > box.bottom || cx - 21 < box.left || cx + 21 > box.right) return true
        }
        return false
      }
      if (clipped()) continue
      // Partly clipped at its own edge, by the same or another container.
      const edges = [document.elementFromPoint(r.left + 1, r.top + 1), document.elementFromPoint(r.right - 1, r.bottom - 1)]
      if (edges.some((e) => e === null || !(el.contains(e) || labelFor(e)))) continue
      // The 44 px square around the centre; a control wider or taller than that has it inside itself.
      const w = box === el ? 21 : Math.min(21, r.width / 2 - 1)
      const h = 21
      for (const [dx, dy] of [[-w, -h], [w, -h], [-w, h], [w, h]] as const) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue
        const hit = document.elementFromPoint(x, y)
        // Nothing there at all: the point is off the page, which a person could not press either.
        if (hit === null) continue
        if (hit && (el.contains(hit) || labelFor(hit))) continue
        const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? ''
        failures.push(`${el.tagName.toLowerCase()} "${name}" ${Math.round(r.width)}x${Math.round(r.height)}: ${Math.round(x)},${Math.round(y)} hits ${hit?.tagName.toLowerCase()} "${hit?.textContent?.trim().slice(0, 20)}"`)
        break
      }
    }
    return failures
  }, within)
}

async function withSession(body: (page: Page) => Promise<void>, theme: ThemeId = 'light'): Promise<void> {
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
    if (theme !== 'light') await useTheme(session.page, theme)
    await session.page.getByRole('button', { name: 'Add workspace' }).click()
    // The shell's navbar and aside settle into place just after the first paint; measure after that.
    await session.page.getByRole('navigation', { name: 'Workspaces' }).waitFor()
    await session.page.waitForTimeout(500)
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

async function createTicket(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New ticket' }).click()
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('In your words').fill('Add hello.txt')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('dialog', { name: 'New ticket' })).toBeHidden()
}

/** Gets the ticket to its question and permission card, as mvp.spec does. */
async function askAndRequest(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Add hello file/ }).click()
  await page.getByLabel('First message (starts the lineup)').fill('Please add hello.txt')
  await page.getByRole('main').getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Looking at the repo before I add hello.txt.')).toBeVisible()
  await expect(page.getByLabel('Message the Implementer')).toHaveValue('')
  await page.getByLabel('Message the Implementer').fill('Go ahead')
  await page.getByRole('main').getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('[data-event="decision"]')).toBeVisible()
}

for (const theme of THEME_IDS)
test(`every screen passes axe, with colour contrast, and every control has a 44 px target (${theme})`, async () => {
  await withSession(async (page) => {
    // The empty board.
    await expectNoAxeViolations(page, 'the empty board')
    expect(await smallTargets(page), 'small targets on the empty board').toEqual([])

    // Two images pasted into the orchestrator's input, side by side above it, then removed.
    const box = page.getByRole('textbox', { name: 'Message the orchestrator' })
    await pasteImage(box, 'one.png')
    await pasteImage(box, 'two.png')
    await expect(page.getByRole('group', { name: 'Images to send' }).getByRole('img', { name: /\.png$/ })).toHaveCount(2)
    await expectNoAxeViolations(page, 'the orchestrator input with images')
    expect(await smallTargets(page, '[aria-label="Orchestrator"]'), 'small targets in the orchestrator input with images').toEqual([])
    await page.getByRole('button', { name: 'Remove one.png' }).click()
    await page.getByRole('button', { name: 'Remove two.png' }).click()
    await expect(page.getByRole('group', { name: 'Images to send' })).toHaveCount(0)

    // A board with cards in two columns.
    await createTicket(page, 'Add hello file')
    await createTicket(page, 'Second ticket')
    await page.getByRole('button', { name: 'Move ticket #2' }).focus()
    await page.keyboard.press('Space')
    await expect(page.locator('[id^="DndLiveRegion"]')).toContainText('Picked up')
    // dnd-kit starts listening for the next key a moment after it announces the pick-up.
    await page.waitForTimeout(200)
    await page.keyboard.press('Escape')
    await expect(page.locator('[id^="DndLiveRegion"]')).toContainText('cancelled')
    // A card being dragged is drawn faded; contrast is measured once it is dropped back.
    await page.waitForTimeout(300)
    await expectNoAxeViolations(page, 'the board with cards')
    expect(await smallTargets(page), 'small targets on the board').toEqual([])

    // The card menu.
    await page.getByRole('button', { name: /Second ticket/ }).focus()
    await page.keyboard.press('Shift+F10')
    await expect(page.getByRole('menuitem', { name: 'Move to Ready' })).toBeVisible()
    await expect(page.getByRole('menu')).toBeVisible()
    expect(await smallTargets(page, '[role="menu"]'), 'small targets in the card menu').toEqual([])
    await page.keyboard.press('Escape')

    // The ticket view with a question and a permission waiting.
    await askAndRequest(page)
    await expect(page.locator('[data-event="decision"]')).toBeVisible()
    await page.locator('[data-event="decision"]').getByRole('radio').first().check()
    await page.locator('[data-event="decision"]').getByRole('button', { name: 'Answer' }).click()
    await expect(page.locator('[data-event="permission"]')).toBeVisible()
    await expectNoAxeViolations(page, 'the ticket view with a permission card')
    expect(await smallTargets(page), 'small targets in the ticket view').toEqual([])

    // The settings window.
    await page.getByRole('navigation', { name: 'Workspaces' }).hover()
    await expect(page.getByRole('navigation', { name: 'Workspaces' })).toHaveAttribute('data-expanded', 'true')
    await expectNoAxeViolations(page, 'the expanded workspace rail')
    expect(await smallTargets(page, 'nav'), 'small targets in the expanded rail').toEqual([])
    await page.getByRole('button', { name: 'Options for repo' }).click()
    await page.getByRole('menuitem', { name: 'Settings' }).click()
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Always allowed in this workspace' })).toBeVisible()
    await expectNoAxeViolations(page, 'the settings window')
    expect(await smallTargets(page, '[role="dialog"]'), 'small targets in the settings window').toEqual([])
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Workspace settings' })).toBeHidden()

    // The Mainbus settings, from the rail.
    const mainbusSettings = page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Mainbus settings' })
    await mainbusSettings.click()
    const drawer = page.getByRole('dialog', { name: 'Mainbus settings' })
    await expect(drawer.getByRole('radiogroup', { name: 'Theme', exact: true })).toBeVisible()
    // Axe measures colours as they are on screen, so wait for the drawer to finish fading in.
    await expect
      .poll(() => page.locator('.mantine-Drawer-root', { has: drawer }).evaluate((root) => root.getAnimations({ subtree: true }).length))
      .toBe(0)
    await expectNoAxeViolations(page, 'the Mainbus settings')
    expect(await smallTargets(page, '[role="dialog"]'), 'small targets in the Mainbus settings').toEqual([])

    // Match Windows and its Light theme and Dark theme choices, still in this theme: Windows, as the page sees it,
    // is in this theme's scheme, and this theme is the pick for it.
    const scheme = themeOf(theme).scheme
    await page.emulateMedia({ colorScheme: scheme })
    await drawer.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name: 'Match Windows' }).check()
    const picks = drawer.getByRole('radiogroup', { name: scheme === 'light' ? 'Light theme' : 'Dark theme' })
    await picks.getByRole('radio', { name: themeOf(theme).name, exact: true }).check()
    await expect(page.locator('html')).toHaveAttribute('data-mainbus-theme', theme)
    await expectNoAxeViolations(page, 'the Mainbus settings with Match Windows')
    expect(await smallTargets(page, '[role="dialog"]'), 'small targets in the Mainbus settings with Match Windows').toEqual([])

    // Esc closes it, and focus is back on the button that opened it.
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(mainbusSettings).toBeFocused()
  }, theme)
})

test('reduced motion stops the outline fade and the spinners', async () => {
  await withSession(async (page) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await createTicket(page, 'Add hello file')
    // Put the ticket in Ready, and after the grace for the person's own change let unattended mode start it:
    // that is Mainbus's change, so the card is outlined, and for reduced motion the outline is still (no fade).
    await page.getByRole('button', { name: /Add hello file/ }).focus()
    await page.keyboard.press('Shift+F10')
    await page.getByRole('menuitem', { name: 'Move to Ready' }).click()
    await expect(page.getByRole('region', { name: 'Ready' }).getByText('Add hello file')).toBeVisible()
    await page.waitForTimeout(2500)
    await page.getByRole('switch', { name: 'Unattended' }).check()
    await expect(page.locator('[data-recently-changed]').first()).toHaveAttribute('data-recently-changed', 'still')
    // No spinner on the page animates, wherever one is showing.
    const animations = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.mantine-Loader-root, .mantine-Loader-root *')).map((el) => getComputedStyle(el).animationName)
    )
    expect(animations.filter((a) => a !== 'none')).toEqual([])
  })
})
