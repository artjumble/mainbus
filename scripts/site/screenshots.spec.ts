/// <reference lib="dom" />
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { BoardTicket } from '../../src/shared/api'
import type { Decision, Workspace } from '../../src/shared/domain'
import { demoScript, makeDemoRepos, TICKETS, type WorkspaceKey } from './demoSeed'
import { advance, capturer, checkSizes, encode, invoke, launchDemo, type Capturer } from './shots'

/**
 * `pnpm site:screenshots`: builds the fictional demo board with FakeRuntime, a temporary data home and two throwaway
 * repositories, tells its story once, and captures each scene for the marketing site in Light and Dark (and Night Owl
 * for the themes section), then encodes them into site/img. Never touches the user's data home, board or repositories.
 */

const MIN = 60_000

test('the marketing site screenshots, from the demo board', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-site-'))
  let app: ElectronApplication | undefined
  let shot: Capturer | undefined
  try {
    const repos = makeDemoRepos(tmp)
    const script = path.join(tmp, 'demo-script.json')
    // The usage limit at the end resets two hours from now, as the banner will say.
    fs.writeFileSync(script, JSON.stringify(demoScript(Math.floor(Date.now() / 1000) + 2 * 60 * 60), null, 2))
    // The engine's clock starts a little back: the time ticket's script moves it on about 18 minutes, and at the stuck
    // check it must be a few minutes past the real time #5's folder was made, or the detector takes its files for still changing.
    const launched = await launchDemo({ tmp, script, repos: [repos['acme-web'], repos['field-notes']], clockStart: new Date(Date.now() - 15 * MIN) })
    app = launched.app
    const page = launched.page
    shot = capturer(page, tmp)

    // Both workspaces, acme-web in front.
    // Opened through the bridge, as the Add workspace dialog would once the folder is picked.
    await page.getByRole('button', { name: 'Add workspace' }).waitFor()
    await invoke(page, 'workspace.open', repos['field-notes'])
    await invoke(page, 'workspace.open', repos['acme-web'])
    await page.getByRole('navigation', { name: 'Workspaces' }).waitFor()
    await invoke(page, 'settings.setMaxAgents', 10)
    const workspaces = await invoke<Workspace[]>(page, 'workspace.list')
    expect(workspaces.map((w) => w.name).sort()).toEqual(['acme-web', 'field-notes'])
    const wsId = (key: WorkspaceKey): string => workspaces.find((w) => w.name === key)!.id
    await focus(page, 'acme-web')

    // Every ticket first, so the numbers are fixed.
    const ids: Record<string, string> = {}
    for (const key of ['acme-web', 'field-notes'] as const) {
      for (const t of TICKETS[key]) {
        const created = await invoke<{ id: string; number: number }>(
          page,
          'ticket.create',
          { title: t.title, intent: t.intent, spec: t.spec, criteria: t.criteria, labels: t.labels, column: t.column, ...(t.kind ? { kind: t.kind } : {}) },
          wsId(key)
        )
        expect(created.number).toBe(t.n)
        ids[`${key}#${t.n}`] = created.id
      }
    }
    const id = (key: string): string => ids[key]!
    const board = async (key: WorkspaceKey): Promise<BoardTicket[]> => (await invoke<{ tickets: BoardTicket[] }>(page, 'board.get', wsId(key))).tickets
    const ticketOf = async (key: string): Promise<BoardTicket> => {
      const [ws, n] = key.split('#') as [WorkspaceKey, string]
      return (await board(ws)).find((t) => t.number === Number(n))!
    }
    const threadHas = async (key: string, text: string): Promise<boolean> =>
      JSON.stringify((await invoke<{ events: unknown[] }>(page, 'thread.get', id(key))).events).includes(text)
    const until = (what: string, check: () => Promise<boolean>, timeout = 60_000) => expect.poll(check, { message: what, timeout }).toBe(true)

    // 1. The time ticket runs alone, while its script moves the clock on, so its breakdown has real minutes in it.
    await invoke(page, 'agent.start', id('acme-web#1'))
    await until('#1 reaches Review', async () => (await ticketOf('acme-web#1')).state.column === 'review', 120_000)

    // 2. The rest of the board: Done, a hold with a date.
    for (const key of ['acme-web#11', 'acme-web#12', 'field-notes#4']) await invoke(page, 'ticket.move', id(key), 'done')
    await invoke(page, 'ticket.hold', id('acme-web#10'), { until: daysFromNow(9, 9), reason: 'Waiting for the CDN contract to be signed.' })

    // 3. The orchestrator drafts tickets, while its panel has nothing else to show.
    const panel = page.getByRole('complementary', { name: 'Orchestrator' })
    const box = panel.getByRole('textbox', { name: 'Message the orchestrator' })
    await box.fill('We’re adding gift cards next. Read the checkout code and draft the tickets for it.')
    await box.press('Enter')
    const drafts = panel.getByRole('group', { name: /^Proposal: Create 3 tickets/ })
    await expect(drafts).toBeVisible({ timeout: 30_000 })
    // From the request down: the request, what it read, and the drafts.
    await panel.getByText('We’re adding gift cards next.').evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await shot('orchestrator')

    // 4. The agents.
    for (const key of ['acme-web#2', 'acme-web#3', 'acme-web#4', 'acme-web#5', 'acme-web#6', 'field-notes#1', 'field-notes#2']) {
      await invoke(page, 'agent.start', id(key))
    }
    await until('#2 is back with its Reviewer', () => threadHas('acme-web#2', 'Checking the new log line'))
    await until('#3 asks', async () => (await ticketOf('acme-web#3')).pendingDecisions.length === 1)
    await until('#4 asks to push', async () => (await ticketOf('acme-web#4')).pendingDecisions.length === 1)
    await until('#6 asks', async () => (await ticketOf('acme-web#6')).pendingDecisions.length === 1)
    await until('#5 fails five times', async () => JSON.stringify((await invoke<{ events: unknown[] }>(page, 'thread.get', id('acme-web#5'))).events).split('received 19.988999999999997').length > 5)
    await until('field-notes #1 reports', async () => (await ticketOf('field-notes#1')).state.column === 'review')
    await until('field-notes #2 is planning', () => threadHas('field-notes#2', 'Reading how notes are stored.'))
    // Later…: #6's question comes back next Monday.
    const deferred = (await invoke<{ decisions: Decision[] }>(page, 'thread.get', id('acme-web#6'))).decisions.find((d) => d.status === 'pending')!
    await invoke(page, 'decision.defer', deferred.id, nextMonday())

    // 5. The stuck agent: the detector's next checks find the same command failing, and the orchestrator is woken.
    await advance(app, 3 * MIN)
    const redirect = panel.getByRole('group', { name: /^Proposal: Redirect the Implementer on #5/ })
    await expect(redirect).toBeVisible({ timeout: 30_000 })
    // From here on the panel shows its latest: the redirect, not the drafts further up.
    const latest = panel.getByText('I’ve proposed one corrective message', { exact: false })
    shot.prepare = () => latest.evaluate((el) => el.scrollIntoView({ block: 'end' }))

    await openTicket(page, 'Fix the flaky cart total test')
    await expect(page.locator('[data-stuck-evidence]').first()).toBeVisible()
    await shot('stuck-redirect')

    // 6. The lineup: the Reviewer handed #2 back once, and is checking it again.
    await openTicket(page, 'Retry failed payment webhooks')
    await expect(page.locator('[data-event="handoff"]').first()).toBeVisible()
    await shot('ticket-lineup')
    // Its own branch and folder: the commits in the thread, the branch in the context pane.
    await page.getByRole('region', { name: 'Branch' }).evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await shot('worktree')

    // 7. A decision in the thread and in the panel (and on the board).
    await openTicket(page, 'Format prices for each currency')
    await expect(page.locator('[data-event="decision"]')).toBeVisible()
    await expect(panel.getByRole('region', { name: 'Waiting on you' })).toBeVisible()
    await shot('decisions')

    // 8. A permission card for the push, a hard stop.
    await openTicket(page, 'Upgrade the payments SDK to v5')
    await expect(page.getByRole('button', { name: /Allow once/ }).first()).toBeVisible()
    await shot('permission-card')

    // 9. The acceptance bar: the person's words, the spec and the criteria the roles ticked; then the time breakdown.
    await openTicket(page, 'Show delivery estimates at checkout')
    await expect(page.getByRole('region', { name: 'Acceptance criteria' })).toBeVisible()
    await shot('acceptance-bar')
    const time = page.getByRole('region', { name: 'Time' })
    await time.getByRole('button', { name: 'Show' }).click()
    await expect(time.getByText(/from the first start to Review/)).toBeVisible()
    await time.scrollIntoViewIfNeeded()
    await shot('time-breakdown')

    // 10. The investigation in field-notes.
    await focus(page, 'field-notes')
    await openTicket(page, 'Why do offline edits go missing after sync?')
    await expect(page.getByRole('button', { name: /Promote/ }).first()).toBeVisible()
    await shot('investigate')

    // 11. The workspaces rail, opened.
    await backToBoard(page)
    await focus(page, 'acme-web')
    const rail = page.getByRole('navigation', { name: 'Workspaces' })
    await rail.hover()
    await expect(rail).toHaveAttribute('data-expanded', 'true')
    await shot('workspaces')
    await page.mouse.move(720, 4)
    await expect(rail).toHaveAttribute('data-expanded', 'false')

    // 12. The hero: the whole board. And the same board in Night Owl for the themes section.
    await shot('board')
    await shot('themes', ['night-owl'])

    // 13. Last, the fleet's limits on the smaller board: room for one agent, so a new start is Queued, then the usage limit.
    await focus(page, 'field-notes')
    await invoke(page, 'settings.setMaxAgents', 1)
    await invoke(page, 'agent.start', id('field-notes#3'))
    await until('field-notes #3 is queued', async () => (await ticketOf('field-notes#3')).state.queuePosition === 1)
    await invoke(page, 'agent.send', id('field-notes#2'), 'Go ahead with the plan.')
    await expect(page.getByText(/Usage limit reached/).first()).toBeVisible({ timeout: 30_000 })
    await shot('usage-cap')
  } finally {
    await app?.close().catch(() => {})
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp folder left behind is harmless.
    }
  }

  // Encoded only once the app is closed, from what was captured.
  await encode(shot!.taken, { slug: 'board', theme: 'light' })
  checkSizes()
})

async function focus(page: Page, name: string): Promise<void> {
  const rail = page.getByRole('navigation', { name: 'Workspaces' })
  await rail.getByRole('button', { name: new RegExp(`^${name}`) }).click()
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible()
  // Off the rail, so it closes again.
  await page.mouse.move(720, 4)
  await expect(rail).toHaveAttribute('data-expanded', 'false')
}

async function openTicket(page: Page, title: string): Promise<void> {
  if (!(await page.getByRole('heading', { name: title }).isVisible())) {
    if (await page.getByRole('main').getByRole('button', { name: /← .* board$/ }).isVisible()) await backToBoard(page)
    await page.getByRole('button', { name: new RegExp(escape(title)) }).first().click()
  }
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
}

async function backToBoard(page: Page): Promise<void> {
  await page.getByRole('main').getByRole('button', { name: /← .* board$/ }).click()
  await expect(page.locator('[data-lane]').first()).toBeVisible()
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `days` from today at `hour` o'clock, as ISO. */
function daysFromNow(days: number, hour: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  d.setHours(hour, 0, 0, 0)
  return d.toISOString()
}

/** Next Monday (at least two days away) at 09:00, as ISO. */
function nextMonday(): string {
  const d = new Date()
  d.setDate(d.getDate() + 2)
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return d.toISOString()
}
