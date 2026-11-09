import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { BoardTicket } from '../shared/api'
import type { Ticket } from '../shared/domain'
import { runGit } from './git/git'
import { resolveHome, type HomePaths } from './home'
import { createEngine, type Engine } from './index'
import { makeRepo } from './intake/testBoard'
import { FakeRuntime, type FakeStep } from './runtime/fakeRuntime'
import type { ExecFn } from './runtime/resolveClaude'
import { eventually } from './testWait'

// Each test starts an engine over a real repository: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

const migrationsDir = path.join(import.meta.dirname, 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-blocked-by-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  engines = []
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const WORKING: FakeStep[] = [{ emit: { kind: 'session', sessionId: 'role-sess' } }, { waitForSend: true }]
const OPEN_TURN: FakeStep[] = [{ emit: { kind: 'session', sessionId: 'orch' } }, { waitForSend: true }]

async function makeEngine(): Promise<{ engine: Engine; runtime: FakeRuntime }> {
  const runtime = new FakeRuntime(WORKING, { orchestrator: OPEN_TURN })
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec })
  engines.push(engine)
  await engine.invoke('workspace.open', repoPath)
  return { engine, runtime }
}

const newTicket = (engine: Engine, title: string, column: 'backlog' | 'ready' = 'backlog', blockedBy?: string[]): Promise<Ticket> =>
  engine.invoke('ticket.create', { title, intent: `Do ${title}`, spec: '', criteria: [], labels: [], column, ...(blockedBy ? { blockedBy } : {}) })

const board = async (engine: Engine): Promise<BoardTicket[]> => (await engine.invoke('board.get')).tickets
const ticketOf = async (engine: Engine, id: string): Promise<BoardTicket> => (await board(engine)).find((t) => t.id === id)!

async function liveTools(engine: Engine, runtime: FakeRuntime) {
  await engine.invoke('orchestrator.send', 'Hello')
  await eventually(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
  return runtime.orchestratorSpecs[0]!.tools
}

describe('creating and editing blockers', () => {
  test('a ticket is created with blockers, which the board shows', async () => {
    const { engine } = await makeEngine()
    const a = await newTicket(engine, 'First')
    const b = await newTicket(engine, 'Second', 'backlog', [a.id])
    expect((await ticketOf(engine, b.id)).blockedBy).toEqual([{ id: a.id, number: 1, title: 'First', done: false }])
    expect((await ticketOf(engine, a.id)).blockedBy).toEqual([])
  })

  test('the ticket view sets and clears blockers at any time; a cycle, a self-link and an unknown ticket are refused', async () => {
    const { engine } = await makeEngine()
    const a = await newTicket(engine, 'First')
    const b = await newTicket(engine, 'Second')
    await engine.invoke('ticket.setBlockedBy', b.id, [a.id])
    expect((await ticketOf(engine, b.id)).blockedBy.map((x) => x.number)).toEqual([1])

    await expect(engine.invoke('ticket.setBlockedBy', a.id, [b.id])).rejects.toThrow("#2 is already blocked by #1, so #1 can't be blocked by #2")
    await expect(engine.invoke('ticket.setBlockedBy', a.id, [a.id])).rejects.toThrow("can't be blocked by itself")
    await expect(engine.invoke('ticket.setBlockedBy', a.id, ['nobody'])).rejects.toThrow('same workspace')
    await expect(newTicket(engine, 'Third', 'backlog', ['nobody'])).rejects.toThrow('same workspace')
    expect((await ticketOf(engine, a.id)).blockedBy).toEqual([])

    await engine.invoke('ticket.setBlockedBy', b.id, [])
    expect((await ticketOf(engine, b.id)).blockedBy).toEqual([])
  })
})

describe('starting a blocked ticket', () => {
  test('Start is refused until the user starts anyway, and starting anyway is recorded in Activity', async () => {
    const { engine, runtime } = await makeEngine()
    const a = await newTicket(engine, 'First')
    const b = await newTicket(engine, 'Second', 'ready', [a.id])

    await expect(engine.invoke('agent.start', b.id)).rejects.toThrow("#1 isn't Done yet")
    expect(runtime.specs).toEqual([])

    await engine.invoke('agent.start', b.id, { startAnyway: true })
    await eventually(async () => expect((await ticketOf(engine, b.id)).state.column).toBe('in_progress'))
    expect((await ticketOf(engine, b.id)).dependencyNotes).toEqual([
      expect.objectContaining({ kind: 'started_blocked', via: 'ticket', blockers: [{ number: 1, title: 'First' }] })
    ])
    // The role is told about its blockers, as background.
    expect(runtime.specs[0]!.appendSystemPrompt).toContain('## Blocked by (background, not the acceptance bar)')
    expect(runtime.specs[0]!.appendSystemPrompt).toContain('not Done yet')
  })

  test('a ticket whose blockers are Done starts with no question and no note', async () => {
    const { engine } = await makeEngine()
    const a = await newTicket(engine, 'First')
    const b = await newTicket(engine, 'Second', 'ready', [a.id])
    await engine.invoke('ticket.move', a.id, 'done')
    await engine.invoke('agent.start', b.id)
    await eventually(async () => expect((await ticketOf(engine, b.id)).state.column).toBe('in_progress'))
    expect((await ticketOf(engine, b.id)).dependencyNotes.filter((n) => n.kind === 'started_blocked')).toEqual([])
  })

  test('moving the last blocker to Done notes the ticket as unblocked, once', async () => {
    const { engine } = await makeEngine()
    const a = await newTicket(engine, 'First')
    const b = await newTicket(engine, 'Second')
    const c = await newTicket(engine, 'Third', 'ready', [a.id, b.id])

    await engine.invoke('ticket.move', a.id, 'done')
    expect((await ticketOf(engine, c.id)).dependencyNotes).toEqual([])
    await engine.invoke('ticket.move', b.id, 'done')
    expect((await ticketOf(engine, c.id)).dependencyNotes).toEqual([
      expect.objectContaining({ kind: 'unblocked', via: null, blockers: [{ number: 1, title: 'First' }, { number: 2, title: 'Second' }] })
    ])
    // Done again changes nothing.
    await engine.invoke('ticket.move', b.id, 'done')
    expect((await ticketOf(engine, c.id)).dependencyNotes).toHaveLength(1)
  })

  test('unattended mode skips a blocked Ready ticket, and starts it once its blocker is Done', async () => {
    const { engine, runtime } = await makeEngine()
    const a = await newTicket(engine, 'First')
    const b = await newTicket(engine, 'Second', 'ready', [a.id])
    await engine.invoke('unattended.set', true)
    await eventually(async () => expect((await engine.invoke('unattended.get')).status.kind).toBe('idle'))
    expect(runtime.specs).toEqual([])
    expect((await ticketOf(engine, b.id)).state.column).toBe('ready')

    await engine.invoke('ticket.move', a.id, 'done')
    await eventually(async () => expect((await ticketOf(engine, b.id)).state.column).toBe('in_progress'))
    expect(runtime.specs).toHaveLength(1)
  })
})

describe('start proposals', () => {
  test('propose_start refuses a blocked ticket with the reason', async () => {
    const { engine, runtime } = await makeEngine()
    const a = await newTicket(engine, 'First')
    const b = await newTicket(engine, 'Second', 'ready', [a.id])
    const tools = await liveTools(engine, runtime)
    expect(await tools.proposeStart({ ticket: b.number })).toBe(
      `Invalid proposal: ticket: #2 is blocked by #1 "First", which isn't Done; don't propose starting it until its blockers are Done. Nothing was stored; fix it and propose again.`
    )
    expect((await engine.invoke('orchestrator.get')).proposals).toEqual([])
  })

  test('dragging a blocked card gives a proposal that says it is blocked; confirming starts it anyway and records that', async () => {
    const { engine, runtime } = await makeEngine()
    const a = await newTicket(engine, 'First')
    const b = await newTicket(engine, 'Second', 'ready', [a.id])
    const proposal = await engine.invoke('ticket.proposeStart', b.id)
    expect(proposal.payload).toMatchObject({ blockedBy: [{ number: 1, title: 'First' }] })

    const confirmed = await engine.invoke('proposal.confirm', proposal.id)
    expect(confirmed.status).toBe('confirmed')
    await eventually(async () => expect((await ticketOf(engine, b.id)).state.column).toBe('in_progress'))
    expect(runtime.specs).toHaveLength(1)
    expect((await ticketOf(engine, b.id)).dependencyNotes).toEqual([expect.objectContaining({ kind: 'started_blocked', via: 'proposal' })])
  })

  test("an orchestrator proposal made before the ticket became blocked fails when confirmed", async () => {
    const { engine, runtime } = await makeEngine()
    const a = await newTicket(engine, 'First')
    const b = await newTicket(engine, 'Second', 'ready')
    const tools = await liveTools(engine, runtime)
    expect(await tools.proposeStart({ ticket: b.number })).toMatch(/^Proposed /)
    const [pending] = (await engine.invoke('orchestrator.get')).proposals
    await engine.invoke('ticket.setBlockedBy', b.id, [a.id])
    const confirmed = await engine.invoke('proposal.confirm', pending!.id)
    expect(confirmed).toMatchObject({ status: 'failed', result: { error: expect.stringContaining('is blocked now') } })
    expect(runtime.specs).toEqual([])
  })
})

describe('the orchestrator tools', () => {
  test('create_tickets takes ticket numbers and draft indexes, so a series is created in order', async () => {
    const { engine, runtime } = await makeEngine()
    const base = await newTicket(engine, 'Base')
    const tools = await liveTools(engine, runtime)
    const answer = await tools.createTickets({
      tickets: [{ title: 'Step one', blocked_by: [base.number] }, { title: 'Step two', blocked_by: [{ draft: 0 }] }, { title: 'Step three', blocked_by: [{ draft: 0 }, { draft: 1 }, base.number] }]
    })
    expect(answer).toMatch(/^Created #2 "Step one", #3 "Step two" and #4 "Step three"/)
    const tickets = await board(engine)
    expect(tickets.map((t) => t.blockedBy.map((b) => b.number))).toEqual([[], [1], [2], [1, 2, 3]].map((l) => l.slice().sort((x, y) => x - y)))
  })

  test('create_tickets refuses a forward or self draft index and an unknown number, creating nothing', async () => {
    const { engine, runtime } = await makeEngine()
    const tools = await liveTools(engine, runtime)
    expect(await tools.createTickets({ tickets: [{ title: 'A', blocked_by: [{ draft: 0 }] }] })).toMatch(/^Invalid: tickets\.0\.blocked_by: draft 0 isn't an earlier ticket/)
    expect(await tools.createTickets({ tickets: [{ title: 'A' }, { title: 'B', blocked_by: [{ draft: 2 }] }, { title: 'C' }] })).toMatch(/draft 2 isn't an earlier ticket/)
    expect(await tools.createTickets({ tickets: [{ title: 'A', blocked_by: [99] }] })).toMatch(/^Invalid: tickets\.0\.blocked_by: there is no ticket #99/)
    expect(await board(engine)).toEqual([])
  })

  test('propose_create_tickets checks the blockers, and confirming creates the series linked', async () => {
    const { engine, runtime } = await makeEngine()
    const tools = await liveTools(engine, runtime)
    expect(await tools.proposeCreateTickets({ tickets: [{ title: 'A', blocked_by: [7] }] })).toMatch(/there is no ticket #7/)
    expect(await tools.proposeCreateTickets({ tickets: [{ title: 'A' }, { title: 'B', blocked_by: [{ draft: 0 }] }] })).toMatch(/^Proposed /)
    const [p] = (await engine.invoke('orchestrator.get')).proposals
    await engine.invoke('proposal.confirm', p!.id)
    const tickets = await board(engine)
    expect(tickets.map((t) => t.blockedBy.map((b) => b.number))).toEqual([[], [1]])
  })

  test('update_ticket sets the full list of blockers, refuses a cycle changing nothing, and Undo puts them back', async () => {
    const { engine, runtime } = await makeEngine()
    const a = await newTicket(engine, 'First')
    const b = await newTicket(engine, 'Second', 'backlog', [a.id])
    const c = await newTicket(engine, 'Third')
    const tools = await liveTools(engine, runtime)

    expect(await tools.updateTicket({ ticket: 1, blocked_by: [2] })).toMatch(/is already blocked by/)
    expect((await ticketOf(engine, a.id)).blockedBy).toEqual([])
    expect(await tools.updateTicket({ ticket: 3, blocked_by: [42] })).toMatch(/There is no ticket #42/)
    expect(await tools.updateTicket({ ticket: 2, blocked_by: [1] })).toMatch(/Nothing to change/)

    expect(await tools.updateTicket({ ticket: 2, blocked_by: [3] })).toMatch(/^Updated #2 "Second" in repo: blocked by\./)
    expect((await ticketOf(engine, b.id)).blockedBy.map((x) => x.number)).toEqual([3])

    const [edit] = (await engine.invoke('orchestrator.get')).edits
    expect(edit).toMatchObject({ fields: ['blockedBy'], before: { blockedBy: [1] }, after: { blockedBy: [3] } })
    await engine.invoke('ticket.undoEdit', edit!.id)
    expect((await ticketOf(engine, b.id)).blockedBy.map((x) => x.number)).toEqual([1])

    await tools.updateTicket({ ticket: 2, blocked_by: [] })
    expect((await ticketOf(engine, b.id)).blockedBy).toEqual([])
    expect(c.number).toBe(3)
  })

  test('Undo is refused after the user changed the blockers by hand', async () => {
    const { engine, runtime } = await makeEngine()
    const a = await newTicket(engine, 'First')
    const b = await newTicket(engine, 'Second')
    const tools = await liveTools(engine, runtime)
    await tools.updateTicket({ ticket: 2, blocked_by: [1] })
    const [edit] = (await engine.invoke('orchestrator.get')).edits
    await new Promise((resolve) => setTimeout(resolve, 5))
    await engine.invoke('ticket.setBlockedBy', b.id, [])
    await expect(engine.invoke('ticket.undoEdit', edit!.id)).rejects.toThrow('has changed since this edit')
    expect(a.number).toBe(1)
  })

  test('get_ticket and list_tickets show the links', async () => {
    const { engine, runtime } = await makeEngine()
    const a = await newTicket(engine, 'First')
    await newTicket(engine, 'Second', 'backlog', [a.id])
    const tools = await liveTools(engine, runtime)
    expect(await tools.getTicket({ number: 2 })).toContain('## Blocked by\n- #1 <ticket-data field="blocker">First</ticket-data>: not Done yet')
    expect(await tools.getTicket({ number: 1 })).toContain('## Blocked by\nNone.')
    expect(await tools.listTickets({})).toContain("· blocked by #1 (not Done; don't propose starting it)")
    await engine.invoke('ticket.move', a.id, 'done')
    expect(await tools.listTickets({})).not.toContain('blocked by')
  })
})
