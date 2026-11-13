/// <reference lib="dom" />
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { THEME_IDS, themeOf, type ThemeId } from '../src/shared/domain'

const root = path.resolve(import.meta.dirname, '..')
const SHOTS = path.join(root, 'test-results', 'artboards')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Mainbus E2E', '-c', 'user.email=e2e@mainbus.test', ...args], {
    cwd,
    windowsHide: true,
    stdio: 'pipe'
  })
}

/** A throwaway git repository with one commit, in a folder of the given name. */
export function makeRepo(parent: string, name: string): string {
  const dir = path.join(parent, name)
  fs.mkdirSync(dir)
  git(dir, 'init', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'README.md'), '# test repo\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'initial')
  return dir
}

export interface Artboard {
  app: ElectronApplication
  page: Page
  /** The throwaway repository the first workspace opens. */
  repo: string
  /** The temporary folder holding the data home and the repositories. */
  tmp: string
}

interface Options {
  /** A FakeRuntime script file, as `MAINBUS_RUNTIME=fake:<file>` takes it. */
  fixture: string
  /** The content size of the window: the artboard's size. */
  size: { width: number; height: number }
  /** Name of the repository folder, which is the workspace's name. */
  repoName?: string
  /** Adds the repository as a workspace first (the default); false leaves the welcome screen. */
  openWorkspace?: boolean
}

export { THEME_IDS, type ThemeId }

/** Picks the Theme the way the settings do (through the bridge), and waits for the page to be drawn in it. */
export async function useTheme(page: Page, id: ThemeId): Promise<void> {
  await page.evaluate((t) => (globalThis as unknown as { mainbus: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).mainbus.invoke('settings.setTheme', t), id)
  await expect(page.locator('html')).toHaveAttribute('data-mainbus-theme', id)
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', themeOf(id).scheme)
}

/**
 * Runs `body` against the app with FakeRuntime, a temporary MAINBUS_HOME and a throwaway repository, sized like the
 * artboard, once in each theme, each time in a fresh data home. Never touches the user's data home or board.
 */
export async function withArtboard(options: Options, body: (board: Artboard) => Promise<void>): Promise<void> {
  // The work once per theme: the time too.
  test.setTimeout(test.info().timeout * THEME_IDS.length)
  for (const id of THEME_IDS) await withArtboardIn(id, options, body)
}

async function withArtboardIn(theme: ThemeId, options: Options, body: (board: Artboard) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-artboard-'))
  let app: ElectronApplication | undefined
  try {
    const home = path.join(tmp, 'home')
    const repo = makeRepo(tmp, options.repoName ?? 'web-app')
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env['ELECTRON_RUN_AS_NODE']
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: { ...env, MAINBUS_HOME: home, MAINBUS_RUNTIME: `fake:${options.fixture}`, MAINBUS_TEST_REPO: repo }
    })
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }, [width, height]) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(width!, height!)
    }, [options.size.width, options.size.height])
    // Light is the default: the Light run leaves the setting alone, as a new user would.
    if (theme !== 'light') await useTheme(page, theme)
    if (options.openWorkspace !== false) {
      await page.getByRole('button', { name: 'Add workspace' }).click()
      // The rail shows before any workspace exists: wait for the board of the one being added.
      await page.getByRole('navigation', { name: 'Workspaces' }).waitFor()
      await page.getByRole('button', { name: 'New ticket' }).waitFor()
    }
    await body({ app, page, repo, tmp })
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }
}

/**
 * Saves a screenshot of the window to test-results/artboards/<slug>.png (ignored by git), for the wireframe pass; in
 * another theme to <slug>-<theme>.png beside it (<slug>-dark.png, <slug>-night-owl.png, ...).
 */
export async function shot(page: Page, slug: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  // Let the recently-changed outline and other short animations settle, so the pictures can be compared.
  await page.waitForTimeout(300)
  const theme = (await page.locator('html').getAttribute('data-mainbus-theme')) ?? 'light'
  await page.screenshot({ path: path.join(SHOTS, `${slug}${theme === 'light' ? '' : `-${theme}`}.png`) })
}

export interface NewTicket {
  title: string
  intent?: string
  spec?: string
  criteria?: string[]
  labels?: string
  column?: 'backlog' | 'ready'
}

/** Creates a ticket through the New ticket dialog. */
export async function createTicket(page: Page, ticket: NewTicket): Promise<void> {
  await page.getByRole('button', { name: 'New ticket' }).first().click()
  await page.getByLabel('Title').fill(ticket.title)
  await page.getByLabel('In your words').fill(ticket.intent ?? ticket.title)
  if (ticket.spec) await page.getByLabel('Spec').fill(ticket.spec)
  if (ticket.criteria) await page.getByLabel('Acceptance criteria').fill(ticket.criteria.join('\n'))
  if (ticket.labels) await page.getByLabel('Labels').fill(ticket.labels)
  if (ticket.column) await page.getByLabel('Column').selectOption(ticket.column)
  await page.getByRole('button', { name: 'Create ticket' }).click()
  await expect(page.getByRole('button', { name: new RegExp(ticket.title) })).toBeVisible()
}

/** Opens the ticket's card from the board. */
export async function openTicket(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(title) }).first().click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
}

/** Back to the board from a ticket. */
export async function backToBoard(page: Page): Promise<void> {
  await page.getByRole('button', { name: /board/ }).click()
}

export interface LaneLayout {
  /** Each lane's top and bottom, and the board's, in the window. */
  lanes: { top: number; bottom: number }[]
  board: { top: number; bottom: number }
  /** The bottom of the board area: the window's height, less the board's bottom padding. */
  areaBottom: number
  /** Every lane's top and bottom border widths, in px. */
  laneBorders: number[]
  /** Every card's top border width, in px. */
  cardBorders: number[]
}

/** Measures the board's lanes (the empty board's placeholder lanes too), their borders and their cards'. */
export function laneLayout(page: Page): Promise<LaneLayout> {
  return page.evaluate(() => {
    const lanes = Array.from(document.querySelectorAll<HTMLElement>('[data-lane]'))
    const board = lanes[0]!.parentElement!
    const root = board.closest<HTMLElement>('main > *') ?? board
    const box = (el: Element): { top: number; bottom: number } => {
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom }
    }
    return {
      lanes: lanes.map(box),
      board: box(board),
      areaBottom: window.innerHeight - parseFloat(getComputedStyle(root).paddingBottom),
      laneBorders: lanes.flatMap((l) => [parseFloat(getComputedStyle(l).borderTopWidth), parseFloat(getComputedStyle(l).borderBottomWidth)]),
      cardBorders: lanes.flatMap((l) =>
        Array.from(l.querySelectorAll('[data-card-title]')).map((t) =>
          parseFloat(getComputedStyle(t.closest('.mantine-Paper-root')!).borderTopWidth)
        )
      )
    }
  })
}

/**
 * Every lane runs the board's full height, and the board at least to the bottom of the window's board area; lanes
 * have no top or bottom border, and cards keep theirs.
 */
export async function expectFullHeightLanes(page: Page): Promise<LaneLayout> {
  const layout = await laneLayout(page)
  expect(layout.lanes).toHaveLength(6)
  for (const lane of layout.lanes) {
    expect(lane.top).toBeCloseTo(layout.board.top, 0)
    expect(lane.bottom).toBeCloseTo(layout.board.bottom, 0)
  }
  expect(layout.board.bottom).toBeGreaterThanOrEqual(layout.areaBottom - 1)
  for (const w of layout.laneBorders) expect(w).toBe(0)
  // 1 px, which the display's scaling can round down to a device pixel.
  for (const w of layout.cardBorders) expect(w).toBeGreaterThan(0)
  return layout
}
