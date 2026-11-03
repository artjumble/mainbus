/// <reference lib="dom" />
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'

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

/**
 * Runs `body` against the app with FakeRuntime, a temporary MAINBUS_HOME and a throwaway repository, sized like the
 * artboard. Never touches the user's data home or board.
 */
export async function withArtboard(options: Options, body: (board: Artboard) => Promise<void>): Promise<void> {
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
    if (options.openWorkspace !== false) {
      await page.getByRole('button', { name: 'Add workspace' }).click()
      await page.getByRole('navigation', { name: 'Workspaces' }).waitFor()
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

/** Saves a screenshot of the window to test-results/artboards/<slug>.png (ignored by git), for the wireframe pass. */
export async function shot(page: Page, slug: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  // Let the recently-changed outline and other short animations settle, so the pictures can be compared.
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(SHOTS, `${slug}.png`) })
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
