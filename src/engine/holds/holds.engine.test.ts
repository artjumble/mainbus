import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { EngineEvent } from '../../shared/api'
import { runGit } from '../git/git'
import { resolveHome, type HomePaths } from '../home'
import { createEngine, type Engine } from '../index'
import { makeRepo } from '../intake/testBoard'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import type { ExecFn } from '../runtime/resolveClaude'
import { FakeClock } from './clock'

// Each test starts an engine over a real repository: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

const START = new Date('2026-11-02T09:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const iso = (daysFromStart: number): string => new Date(START.getTime() + daysFromStart * DAY).toISOString()

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]
let clock: FakeClock

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-holds-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  engines = []
  clock = new FakeClock(START)
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const WORKING: FakeStep[] = [{ emit: { kind: 'session', sessionId: 'role-sess' } }, { waitForSend: true }]
const turnEnd = (): FakeStep => ({ emit: { kind: 'turn_end', ok: true } })

async function makeEngine(runtime: FakeRuntime, clockToUse: FakeClock = clock, open = true): Promise<Engine> {
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec, clock: clockToUse })
  engines.push(engine)
  if (open) await engine.invoke('workspace.open', repoPath)
  return engine
}

const newTicket = (engine: Engine, column: 'backlog' | 'ready' = 'ready', title = 'Login') =>
  engine.invoke('ticket.create', { title, intent: 'Add a login form', spec: '', criteria: [], labels: [], column })

const boardOf = async (engine: Engine) => (await engine.invoke('board.get')).tickets
const holdOf = async (engine: Engine, id: string) => (await boardOf(engine)).find((t) => t.id === id)!.hold

describe('ticket.hold and ticket.unhold', () => {
  test('hold a ticket with or without a date, and unhold it; the board carries the hold', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    const a = await newTicket(engine, 'ready', 'A')
    const b = await newTicket(engine, 'ready', 'B')
    expect(await holdOf(engine, a.id)).toBeNull()

    const plain = await engine.invoke('ticket.hold', a.id)
    expect(plain).toMatchObject({ targetKind: 'ticket', targetId: a.id, until: null, reason: null, createdBy: 'user', releasedAt: null })
    const dated = await engine.invoke('ticket.hold', b.id, { until: iso(2), reason: 'Waiting for the API' })
    expect(dated).toMatchObject({ until: iso(2), reason: 'Waiting for the API' })
    expect(await holdOf(engine, a.id)).toEqual(plain)
    expect(await holdOf(engine, b.id)).toEqual(dated)

    await engine.invoke('ticket.unhold', a.id)
    expect(await holdOf(engine, a.id)).toBeNull()
    expect(await holdOf(engine, b.id)).toEqual(dated)
    // Nothing to release: not an error.
    await engine.invoke('ticket.unhold', a.id)
  })

  test('a ticket has one hold: holding it again changes the date and keeps the hold', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    const t = await newTicket(engine)
    const first = await engine.invoke('ticket.hold', t.id)
    const second = await engine.invoke('ticket.hold', t.id, { until: iso(3) })
    expect(second).toMatchObject({ id: first.id, until: iso(3) })
    const third = await engine.invoke('ticket.hold', t.id)
    expect(third).toMatchObject({ id: first.id, until: null })
  })

  test('refuses a date that has passed, a bad date, and a Done ticket, holding nothing', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    const t = await newTicket(engine)
    await expect(engine.invoke('ticket.hold', t.id, { until: iso(-1) })).rejects.toThrow('The date has already passed')
    await expect(engine.invoke('ticket.hold', t.id, { until: 'next week' })).rejects.toThrow('not a valid date')
    expect(await holdOf(engine, t.id)).toBeNull()
    await engine.invoke('ticket.move', t.id, 'done')
    await expect(engine.invoke('ticket.hold', t.id)).rejects.toThrow('a Done ticket can\'t be held')
  })

  test('moving a held ticket to Done releases its hold', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    const t = await newTicket(engine)
    await engine.invoke('ticket.hold', t.id)
    await engine.invoke('ticket.move', t.id, 'done')
    expect(await holdOf(engine, t.id)).toBeNull()
  })

  test("holding a running ticket doesn't stop its agent", async () => {
    const runtime = new FakeRuntime(WORKING)
    const engine = await makeEngine(runtime)
    const t = await newTicket(engine)
    await engine.invoke('agent.start', t.id)
    await vi.waitFor(async () => expect((await boardOf(engine))[0]!.state.agentStatus).toBe('working'))
    await engine.invoke('ticket.hold', t.id)
    expect((await boardOf(engine))[0]).toMatchObject({ state: { agentStatus: 'working', column: 'in_progress' }, hold: { until: null } })
    expect(runtime.interrupted).toEqual([])
  })

  test('starting a held ticket by hand releases the hold', async () => {
    const engine = await makeEngine(new FakeRuntime(WORKING))
    const t = await newTicket(engine)
    await engine.invoke('ticket.hold', t.id, { until: iso(5) })
    await engine.invoke('agent.start', t.id)
    expect(await holdOf(engine, t.id)).toBeNull()
  })

  test('a start that fails leaves the hold', async () => {
    const engine = await makeEngine(new FakeRuntime(WORKING))
    const t = await newTicket(engine)
    await engine.invoke('agent.start', t.id)
    await engine.invoke('ticket.hold', t.id)
    await expect(engine.invoke('agent.start', t.id)).rejects.toThrow()
    expect(await holdOf(engine, t.id)).not.toBeNull()
  })

  test('emits a board change when a hold is placed or released', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    const t = await newTicket(engine)
    const events: EngineEvent[] = []
    engine.on((e) => events.push(e))
    await engine.invoke('ticket.hold', t.id)
    await engine.invoke('ticket.unhold', t.id)
    expect(events.filter((e) => e.type === 'board.changed')).toHaveLength(2)
  })
})

describe('release by date', () => {
  test('a single timer releases a hold when its date passes, and the board changes', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    const soon = await newTicket(engine, 'ready', 'Soon')
    const later = await newTicket(engine, 'ready', 'Later')
    await engine.invoke('ticket.hold', later.id, { until: iso(3) })
    await engine.invoke('ticket.hold', soon.id, { until: iso(1) })
    // One timer, set for the next hold due.
    expect(clock.pending).toBe(1)

    const events: EngineEvent[] = []
    engine.on((e) => events.push(e))
    await clock.advance(DAY - 1)
    expect(await holdOf(engine, soon.id)).not.toBeNull()
    await clock.advance(1)
    expect(await holdOf(engine, soon.id)).toBeNull()
    expect(await holdOf(engine, later.id)).not.toBeNull()
    expect(events.some((e) => e.type === 'board.changed')).toBe(true)
    // It is set again for the one that is left, and the orchestrator's wake turn waits five seconds behind the release.
    expect(clock.pending).toBe(2)
    await clock.advance(5000)
    expect(clock.pending).toBe(1)

    await clock.advance(2 * DAY)
    expect(await holdOf(engine, later.id)).toBeNull()
    expect(clock.pending).toBe(0)
  })

  test('an unheld ticket leaves no timer behind, and a hold with no date sets none', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    const t = await newTicket(engine)
    await engine.invoke('ticket.hold', t.id, { until: iso(1) })
    expect(clock.pending).toBe(1)
    await engine.invoke('ticket.unhold', t.id)
    expect(clock.pending).toBe(0)
    await engine.invoke('ticket.hold', t.id)
    expect(clock.pending).toBe(0)
  })

  test('holds that came due while Mainbus was closed are released at launch', async () => {
    const first = await makeEngine(new FakeRuntime([]))
    const due = await newTicket(first, 'ready', 'Due')
    const waiting = await newTicket(first, 'ready', 'Waiting')
    const undated = await newTicket(first, 'ready', 'Undated')
    await first.invoke('ticket.hold', due.id, { until: iso(1) })
    await first.invoke('ticket.hold', waiting.id, { until: iso(10) })
    await first.invoke('ticket.hold', undated.id)
    await first.dispose()

    const later = new FakeClock(new Date(START.getTime() + 3 * DAY))
    const second = await makeEngine(new FakeRuntime([]), later, false)
    expect(await holdOf(second, due.id)).toBeNull()
    expect(await holdOf(second, waiting.id)).not.toBeNull()
    expect(await holdOf(second, undated.id)).not.toBeNull()
    // The timer is set for the one still waiting, and the orchestrator's wake turn is due five seconds after launch.
    expect(later.pending).toBe(2)
  })
})

describe('what a hold blocks', () => {
  test("propose_start refuses a held ticket, saying why; a start proposed before the hold fails and starts nothing", async () => {
    const runtime = new FakeRuntime([], { orchestrator: [{ emit: { kind: 'session', sessionId: 's' } }, { waitForSend: true }] })
    const engine = await makeEngine(runtime)
    const t = await newTicket(engine)
    await engine.invoke('orchestrator.send', 'Start the login ticket')
    await vi.waitFor(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    const tools = runtime.orchestratorSpecs[0]!.tools

    expect(await tools.proposeStart({ ticket: t.number })).toMatch(/^Proposed /)
    const [pending] = (await engine.invoke('orchestrator.get')).proposals
    await engine.invoke('ticket.hold', t.id, { until: iso(2) })

    expect(await tools.proposeStart({ ticket: t.number })).toBe(
      `Invalid proposal: ticket: #${t.number} is on hold until 2026-11-04; the user has to release the hold first. Nothing was stored; fix it and propose again.`
    )
    const confirmed = await engine.invoke('proposal.confirm', pending!.id)
    expect(confirmed).toMatchObject({ status: 'failed', result: { error: expect.stringContaining('is on hold') } })
    expect(runtime.specs).toEqual([])
    expect((await boardOf(engine))[0]!.state.column).toBe('ready')
  })

  test('unattended mode skips a held Ready ticket and starts the next one', async () => {
    const runtime = new FakeRuntime(WORKING)
    const engine = await makeEngine(runtime)
    const held = await newTicket(engine, 'ready', 'Held')
    const open = await newTicket(engine, 'ready', 'Open')
    await engine.invoke('ticket.hold', held.id)

    await engine.invoke('unattended.set', true)
    await vi.waitFor(async () => expect((await boardOf(engine)).find((t) => t.id === open.id)!.state.column).toBe('in_progress'))
    expect((await boardOf(engine)).find((t) => t.id === held.id)!.state.column).toBe('ready')
    expect(runtime.specs).toHaveLength(1)
  })

  test('with only a held ticket in Ready it stays idle, and starts it when the hold runs out', async () => {
    const runtime = new FakeRuntime(WORKING)
    const engine = await makeEngine(runtime)
    const held = await newTicket(engine, 'ready', 'Held')
    await engine.invoke('ticket.hold', held.id, { until: iso(1) })

    await engine.invoke('unattended.set', true)
    await vi.waitFor(async () => expect((await engine.invoke('unattended.get')).status.kind).toBe('idle'))
    expect(runtime.specs).toEqual([])

    await clock.advance(DAY)
    await vi.waitFor(async () => expect((await boardOf(engine))[0]!.state.column).toBe('in_progress'))
    expect(runtime.specs).toHaveLength(1)
    expect(await holdOf(engine, held.id)).toBeNull()
  })
})

describe('the orchestrator hears of released holds', () => {
  const orchestrator: FakeStep[] = [{ emit: { kind: 'session', sessionId: 's' } }, turnEnd(), { waitForSend: true }, turnEnd()]

  test('its next message lists holds released by date or by hand, and not the ones still held', async () => {
    const runtime = new FakeRuntime([], { orchestrator })
    const engine = await makeEngine(runtime)
    const byDate = await newTicket(engine, 'ready', 'By date')
    const byHand = await newTicket(engine, 'ready', 'By hand')
    const still = await newTicket(engine, 'ready', 'Still held')
    await engine.invoke('orchestrator.send', 'Hello')
    await vi.waitFor(async () => expect((await engine.invoke('orchestrator.get')).status).toBe('idle'))

    await clock.advance(1000)
    await engine.invoke('ticket.hold', byDate.id, { until: iso(1) })
    await engine.invoke('ticket.hold', byHand.id)
    await engine.invoke('ticket.hold', still.id)
    await engine.invoke('ticket.unhold', byHand.id)
    await clock.advance(DAY)

    await engine.invoke('orchestrator.send', 'Anything new?')
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
    const message = runtime.sent[0]!
    expect(message).toContain('[Mainbus] Since your last turn, these held tickets were released:')
    expect(message).toContain(`- #${byDate.number} "By date" is no longer held (its date, 2026-11-03, came). It can be started again.`)
    expect(message).toContain(`- #${byHand.number} "By hand" is no longer held. It can be started again.`)
    expect(message).not.toContain('Still held')
  })

  test('says nothing when no hold was released', async () => {
    const runtime = new FakeRuntime([], { orchestrator })
    const engine = await makeEngine(runtime)
    const t = await newTicket(engine)
    await engine.invoke('ticket.hold', t.id)
    await engine.invoke('orchestrator.send', 'Hello')
    await vi.waitFor(async () => expect((await engine.invoke('orchestrator.get')).status).toBe('idle'))
    await engine.invoke('orchestrator.send', 'Again')
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
    expect(runtime.sent[0]).not.toContain('held tickets were released')
  })
})

describe('propose_hold', () => {
  async function turn() {
    const runtime = new FakeRuntime([], { orchestrator: [{ emit: { kind: 'session', sessionId: 's' } }, { waitForSend: true }] })
    const engine = await makeEngine(runtime)
    const t = await newTicket(engine)
    await engine.invoke('orchestrator.send', 'Hold the login ticket until Wednesday')
    await vi.waitFor(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    return { engine, t, tools: runtime.orchestratorSpecs[0]!.tools }
  }

  test('confirmed, holds the ticket until the date', async () => {
    const { engine, t, tools } = await turn()
    expect(await tools.proposeHold({ ticket: t.number, until: iso(2), reason: 'You said Wednesday' })).toMatch(/^Proposed /)
    const [p] = (await engine.invoke('orchestrator.get')).proposals
    expect(p).toMatchObject({ kind: 'hold', payload: { number: t.number, until: iso(2), reason: 'You said Wednesday' } })
    expect(await holdOf(engine, t.id)).toBeNull()

    const done = await engine.invoke('proposal.confirm', p!.id)
    expect(done).toMatchObject({ status: 'confirmed', result: { number: t.number, until: iso(2) } })
    expect(await holdOf(engine, t.id)).toMatchObject({ until: iso(2), reason: 'You said Wednesday' })
  })

  test('overridden, takes the date the user chose, or none', async () => {
    const { engine, t, tools } = await turn()
    await tools.proposeHold({ ticket: t.number, until: iso(2), reason: 'Wait' })
    const [p] = (await engine.invoke('orchestrator.get')).proposals
    const changed = await engine.invoke('proposal.confirm', p!.id, { until: iso(5) })
    expect(changed).toMatchObject({ status: 'overridden', result: { until: iso(5) } })
    expect(await holdOf(engine, t.id)).toMatchObject({ until: iso(5) })

    await tools.proposeHold({ ticket: t.number, until: iso(2), reason: 'Wait' })
    const second = (await engine.invoke('orchestrator.get')).proposals[1]!
    await engine.invoke('proposal.confirm', second.id, { until: null })
    expect(await holdOf(engine, t.id)).toMatchObject({ until: null })
  })

  test('an invalid override leaves the proposal pending', async () => {
    const { engine, t, tools } = await turn()
    await tools.proposeHold({ ticket: t.number, reason: 'Wait' })
    const [p] = (await engine.invoke('orchestrator.get')).proposals
    await expect(engine.invoke('proposal.confirm', p!.id, { until: iso(-1) })).rejects.toThrow('until: The date has already passed')
    await expect(engine.invoke('proposal.confirm', p!.id, { when: 'soon', until: null })).rejects.toThrow('Unknown field: when')
    expect((await engine.invoke('orchestrator.get')).proposals[0]!.status).toBe('pending')
  })

  test('validates the proposal against the board', async () => {
    const { engine, t, tools } = await turn()
    expect(await tools.proposeHold({ ticket: t.number })).toMatch(/^Invalid proposal: reason: /)
    expect(await tools.proposeHold({ ticket: 99, reason: 'x' })).toMatch(/^Invalid proposal: ticket: there is no ticket #99/)
    expect(await tools.proposeHold({ ticket: t.number, until: 'soon', reason: 'x' })).toMatch(/^Invalid proposal: until: The date is not a valid date/)
    expect(await tools.proposeHold({ ticket: t.number, until: iso(-1), reason: 'x' })).toMatch(/^Invalid proposal: until: The date has already passed/)
    await engine.invoke('ticket.move', t.id, 'done')
    expect(await tools.proposeHold({ ticket: t.number, reason: 'x' })).toMatch(/is Done/)
    expect((await engine.invoke('orchestrator.get')).proposals).toEqual([])
  })
})
