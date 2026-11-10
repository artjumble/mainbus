import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runGit } from '../git/git'
import { FakeClock } from '../holds/clock'
import { resolveHome, type HomePaths } from '../home'
import { createEngine, type Engine } from '../index'
import { makeRepo } from '../intake/testBoard'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import type { ExecFn } from '../runtime/resolveClaude'
import { eventually } from '../testWait'

// Each test starts an engine over a real repository: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

const START = new Date('2026-11-02T09:00:00.000Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const WAIT = 2 * MINUTE

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]
let clock: FakeClock

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-donereview-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  engines = []
  clock = new FakeClock(START)
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const turnEnd = (): FakeStep => ({ emit: { kind: 'turn_end', ok: true } })
const session = (id: string): FakeStep => ({ emit: { kind: 'session', sessionId: id } })

/** Every role hands off, with a note for the next one. */
const HANDING_OFF: FakeStep[] = [
  session('role-sess'),
  { callTool: 'handoff', args: { summary: 'Did the work', notesForNext: 'worth its own ticket: flaky vitest startup' } },
  turnEnd()
]
const QUIET_ORCHESTRATOR: FakeStep[] = [session('orch'), turnEnd(), { waitForSend: true }]

async function makeEngine(orchestrator: FakeStep[] = QUIET_ORCHESTRATOR) {
  const runtime = new FakeRuntime(HANDING_OFF, { orchestrator })
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec, clock })
  engines.push(engine)
  await engine.invoke('workspace.open', repoPath)
  return { engine, runtime }
}

type TestEngine = Engine
const newTicket = (engine: TestEngine, title: string, column: 'ready' | 'backlog' = 'ready') =>
  engine.invoke('ticket.create', { title, intent: `Do ${title}`, spec: '', criteria: [], labels: [], column })
const ticketOf = async (engine: TestEngine, id: string) => (await engine.invoke('board.get')).tickets.find((t) => t.id === id)!
const idle = (engine: TestEngine) => eventually(async () => expect((await engine.invoke('orchestrator.get')).status).toBe('idle'))

/** A ticket whose roles ran and handed off, now in Review. */
async function ran(engine: TestEngine, title: string) {
  const ticket = await newTicket(engine, title)
  await engine.invoke('agent.start', ticket.id)
  await eventually(async () => expect((await ticketOf(engine, ticket.id)).state.column).toBe('review'))
  return ticket
}

const moveToDone = async (engine: TestEngine, id: string) => {
  expect(await engine.invoke('ticket.move', id, 'done')).toBe('moved')
}
const moveOut = (engine: TestEngine, id: string) => engine.invoke('ticket.move', id, 'ready')

const pendingWakes = async (engine: TestEngine) => (await engine.invoke('orchestrator.get')).events.filter((e) => e.event.kind === 'wake')

describe('a ticket that reached Done', () => {
  test('gives the orchestrator a review turn after the wait, with its handoff notes, and records the result in its Activity', async () => {
    const { engine, runtime } = await makeEngine()
    const ticket = await ran(engine, 'Login')
    await moveToDone(engine, ticket.id)

    await clock.advance(WAIT - 1)
    expect(runtime.orchestratorSpecs).toHaveLength(0)
    await clock.advance(1)
    await eventually(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    await idle(engine)

    const prompt = runtime.orchestratorSpecs[0]!.prompt
    expect(prompt).toContain(`#${ticket.number} <ticket-data field="title">Login</ticket-data> (workspace "repo"): reached Done`)
    expect(prompt).toContain('worth its own ticket: flaky vitest startup')
    expect(prompt).toContain('At most 3 follow-up tickets')
    expect(prompt).toContain(`- #${ticket.number} "Login" (workspace "repo") (done)`)

    const thread = await engine.invoke('orchestrator.get')
    const wake = thread.events.map((e) => e.event).find((e) => e.kind === 'wake')
    expect(wake).toMatchObject({ kind: 'wake', reviews: 1 })
    const { events } = await engine.invoke('thread.get', ticket.id)
    expect(events.map((e) => e.event)).toContainEqual({ kind: 'done_reviewed', followUps: 0, proposalIds: [] })
  })

  test('is not reviewed when it never ran', async () => {
    const { engine, runtime } = await makeEngine()
    const ticket = await newTicket(engine, 'Never started')
    await moveToDone(engine, ticket.id)
    await clock.advance(HOUR)
    expect(runtime.orchestratorSpecs).toHaveLength(0)
  })

  test('is not reviewed when the setting is off, and the wait and the switch are validated', async () => {
    const { engine, runtime } = await makeEngine()
    expect(await engine.invoke('settings.setReviewDone', { on: false })).toMatchObject({ reviewDoneTickets: false, reviewDoneWaitMinutes: 2 })
    await expect(engine.invoke('settings.setReviewDone', { waitMinutes: 0 })).rejects.toThrow('whole number of minutes')
    const ticket = await ran(engine, 'Login')
    await moveToDone(engine, ticket.id)
    await clock.advance(HOUR)
    expect(runtime.orchestratorSpecs).toHaveLength(0)
  })

  test('turned off while the row waits: nothing is presented and no turn starts', async () => {
    const { engine, runtime } = await makeEngine()
    const ticket = await ran(engine, 'Login')
    await moveToDone(engine, ticket.id)
    await engine.invoke('settings.setReviewDone', { on: false })
    await clock.advance(HOUR)
    expect(runtime.orchestratorSpecs).toHaveLength(0)
  })

  test('uses the wait the user chose', async () => {
    const { engine, runtime } = await makeEngine()
    await engine.invoke('settings.setReviewDone', { waitMinutes: 10 })
    const ticket = await ran(engine, 'Login')
    await moveToDone(engine, ticket.id)
    await clock.advance(WAIT * 4)
    expect(runtime.orchestratorSpecs).toHaveLength(0)
    await clock.advance(WAIT)
    await eventually(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
  })

  test('several Done moves close together are one turn that names them all', async () => {
    const { engine, runtime } = await makeEngine()
    const a = await ran(engine, 'Alpha')
    const b = await ran(engine, 'Bravo')
    await moveToDone(engine, a.id)
    await clock.advance(MINUTE)
    await moveToDone(engine, b.id)
    // The first one's wait is over, but the second is still inside its own.
    await clock.advance(WAIT - MINUTE)
    expect(runtime.orchestratorSpecs).toHaveLength(0)
    await clock.advance(MINUTE)
    await eventually(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    await idle(engine)
    const prompt = runtime.orchestratorSpecs[0]!.prompt
    expect(prompt).toContain('>Alpha<')
    expect(prompt).toContain('>Bravo<')
    expect(await pendingWakes(engine)).toHaveLength(1)
  })

  test('moved out of Done and back in the same day is not reviewed again; after a day it is', async () => {
    const orchestrator: FakeStep[] = [session('orch'), turnEnd(), { waitForSend: true }, turnEnd(), { waitForSend: true }, turnEnd()]
    const { engine, runtime } = await makeEngine(orchestrator)
    const ticket = await ran(engine, 'Login')
    await moveToDone(engine, ticket.id)
    await clock.advance(WAIT)
    await eventually(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    await idle(engine)

    await moveOut(engine, ticket.id)
    await moveToDone(engine, ticket.id)
    await clock.advance(HOUR)
    expect(await pendingWakes(engine)).toHaveLength(1)

    await moveOut(engine, ticket.id)
    await clock.advance(25 * HOUR)
    await moveToDone(engine, ticket.id)
    await clock.advance(WAIT)
    await eventually(async () => expect(await pendingWakes(engine)).toHaveLength(2))
  })

  test('moved back out of Done before the review: nothing to review', async () => {
    const { engine, runtime } = await makeEngine()
    const ticket = await ran(engine, 'Login')
    await moveToDone(engine, ticket.id)
    await moveOut(engine, ticket.id)
    await clock.advance(HOUR)
    expect(runtime.orchestratorSpecs).toHaveLength(0)
  })
})

describe('a review turn proposing follow-ups', () => {
  const draft = (title: string) => ({ title, spec: 'Fix it', criteria: ['It works'] })

  test('stores the card with the source, creates an agent-filed ticket on confirm, and counts the follow-up in the Activity', async () => {
    const proposing: FakeStep = {
      callTool: 'proposeCreateTickets',
      args: { follow_up_of: 1, tickets: [draft('Fix flaky vitest startup')], context: 'From #1, the Implementer note: "worth its own ticket: flaky vitest startup".' }
    }
    const { engine, runtime } = await makeEngine([session('orch'), proposing, turnEnd()])
    const ticket = await ran(engine, 'Login')
    await moveToDone(engine, ticket.id)
    await clock.advance(WAIT)
    await eventually(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    await idle(engine)

    const thread = await engine.invoke('orchestrator.get')
    expect(thread.proposals).toHaveLength(1)
    const proposal = thread.proposals[0]!
    expect(proposal).toMatchObject({ kind: 'create_tickets', status: 'pending', payload: { followUpOf: { number: 1, title: 'Login' } } })
    const { events } = await engine.invoke('thread.get', ticket.id)
    expect(events.map((e) => e.event)).toContainEqual({ kind: 'done_reviewed', followUps: 1, proposalIds: [proposal.id] })

    await engine.invoke('proposal.confirm', proposal.id)
    const created = (await engine.invoke('board.get')).tickets.find((t) => t.title === 'Fix flaky vitest startup')!
    expect(created.intent[0]).toMatchObject({ source: { kind: 'agent', agent: 'orchestrator' } })
    expect(created.intent[0]!.text).toContain('Follow-up to #1 "Login"')
    expect(created.intent.some((e) => e.source === undefined)).toBe(false)
  })

  test('refuses a follow-up with no or an unknown follow_up_of, a fourth ticket, and any direct creation', async () => {
    // The turn stays open (waiting for a message) so the tools can be called inside it.
    const { engine, runtime } = await makeEngine([session('orch'), { waitForSend: true }])
    const ticket = await ran(engine, 'Login')
    await moveToDone(engine, ticket.id)
    await clock.advance(WAIT)
    await eventually(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    const tools = runtime.orchestratorSpecs[0]!.tools
    const context = 'From #1: worth its own ticket.'

    expect(await tools.proposeCreateTickets({ tickets: [draft('A')], context })).toContain('follow_up_of: required')
    expect(await tools.proposeCreateTickets({ follow_up_of: 99, tickets: [draft('A')], context })).toContain('(#1)')
    expect(await tools.proposeCreateTickets({ follow_up_of: 1, tickets: [draft('A')] })).toContain('context: required for a follow-up')
    expect(await tools.proposeCreateTickets({ follow_up_of: 1, tickets: [draft('A'), draft('B'), draft('C')], context })).toContain('Proposed')
    const fourth = await tools.proposeCreateTickets({ follow_up_of: 1, tickets: [draft('D')], context })
    expect(fourth).toContain('at most 3')
    expect(fourth).toContain('Summarise the rest in one message, ranked')
    expect(await tools.createTickets({ tickets: [draft('E')] })).toContain('Tickets can only be created in answer to a message of the user')
    expect((await engine.invoke('orchestrator.get')).proposals).toHaveLength(1)
  })

  test('a review turn that finds nothing stays quiet: no proposal and no message, and the Activity says none', async () => {
    const { engine, runtime } = await makeEngine()
    const ticket = await ran(engine, 'Login')
    await moveToDone(engine, ticket.id)
    await clock.advance(WAIT)
    await eventually(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    await idle(engine)
    const thread = await engine.invoke('orchestrator.get')
    expect(thread.proposals).toEqual([])
    expect(thread.events.filter((e) => e.event.kind === 'message')).toEqual([])
  })
})
