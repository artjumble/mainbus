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
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-deferred-'))
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

async function makeEngine(runtime: FakeRuntime, clockToUse: FakeClock = clock, open = true): Promise<Engine> {
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec, clock: clockToUse })
  engines.push(engine)
  if (open) await engine.invoke('workspace.open', repoPath)
  return engine
}

const newTicket = (engine: Engine) =>
  engine.invoke('ticket.create', { title: 'Login', intent: 'Add a login form', spec: '', criteria: [], labels: [], column: 'ready' })

const boardOf = async (engine: Engine) => (await engine.invoke('board.get')).tickets
const ticketOf = async (engine: Engine, id: string) => (await boardOf(engine)).find((t) => t.id === id)!

const ASKING: FakeStep[] = [
  { emit: { kind: 'session', sessionId: 'role-sess' } },
  { callTool: 'askUser', args: { question: 'Which API?', options: ['Old API', 'New API'] } },
  turnEnd(),
  { waitForSend: true }
]
const ORCHESTRATOR: FakeStep[] = [{ emit: { kind: 'session', sessionId: 's' } }, turnEnd(), { waitForSend: true }, turnEnd()]

/** An engine with a started ticket whose agent has asked; its decision, and everything the engine emitted. */
async function asked() {
  const runtime = new FakeRuntime(ASKING, { orchestrator: ORCHESTRATOR })
  const engine = await makeEngine(runtime)
  const events: EngineEvent[] = []
  engine.on((e) => events.push(e))
  const ticket = await newTicket(engine)
  await engine.invoke('agent.start', ticket.id)
  await vi.waitFor(async () => expect((await ticketOf(engine, ticket.id)).pendingDecisions).toHaveLength(1))
  const [decision] = (await ticketOf(engine, ticket.id)).pendingDecisions
  return { engine, runtime, events, ticket, decision: decision! }
}

describe('decision.defer', () => {
  test('moves the ticket to In progress, waiting on you until the date, and out of Needs you', async () => {
    const { engine, events, ticket, decision } = await asked()
    const deferred = await engine.invoke('decision.defer', decision.id, iso(1))
    expect(deferred).toMatchObject({ status: 'deferred', deferredUntil: iso(1) })

    const t = await ticketOf(engine, ticket.id)
    expect(t.pendingDecisions).toEqual([])
    expect(t.deferredDecisions).toEqual([expect.objectContaining({ id: decision.id, status: 'deferred', deferredUntil: iso(1) })])
    expect(t.state).toMatchObject({ column: 'in_progress', agentStatus: 'waiting_on_you', phase: 'waiting_on_you', deferredUntil: iso(1) })
    expect(events).toContainEqual({ type: 'decision.changed', decision: expect.objectContaining({ id: decision.id, status: 'deferred' }) })
    expect(clock.pending).toBe(1)
  })

  test('refuses a date that has passed and a second deferral', async () => {
    const { engine, decision } = await asked()
    await expect(engine.invoke('decision.defer', decision.id, iso(-1))).rejects.toThrow('The date has already passed')
    await engine.invoke('decision.defer', decision.id, iso(1))
    await expect(engine.invoke('decision.defer', decision.id, iso(2))).rejects.toThrow('Already deferred')
  })

  test('on its date it is pending again, in Needs you, and the board and thread are told', async () => {
    const { engine, events, ticket, decision } = await asked()
    await engine.invoke('decision.defer', decision.id, iso(1))
    events.length = 0
    await clock.advance(DAY)

    expect(events).toContainEqual({
      type: 'decision.changed',
      decision: expect.objectContaining({ id: decision.id, status: 'pending', deferredUntil: null })
    })
    expect(events.some((e) => e.type === 'board.changed')).toBe(true)
    const t = await ticketOf(engine, ticket.id)
    expect(t.pendingDecisions.map((d) => d.id)).toEqual([decision.id])
    expect(t.deferredDecisions).toEqual([])
    expect(t.state).toMatchObject({ column: 'needs_you', deferredUntil: null })
    const thread = await engine.invoke('thread.get', ticket.id)
    expect(thread.decisions.find((d) => d.id === decision.id)?.status).toBe('pending')
  })

  test('one whose date passed while Mainbus was closed is pending at launch', async () => {
    const { engine, ticket, decision } = await asked()
    await engine.invoke('decision.defer', decision.id, iso(1))
    await engine.dispose()
    const later = new FakeClock(new Date(START.getTime() + 3 * DAY))
    const second = await makeEngine(new FakeRuntime([]), later)
    const t = await ticketOf(second, ticket.id)
    expect(t.pendingDecisions.map((d) => d.id)).toEqual([decision.id])
    expect(t.state.column).toBe('needs_you')
  })

  test('answering a deferred decision delivers the answer to the agent and releases the hold', async () => {
    const { engine, runtime, ticket, decision } = await asked()
    await engine.invoke('decision.defer', decision.id, iso(1))
    await engine.invoke('decision.answer', decision.id, { kind: 'option', index: 1 }, 'orchestrator')
    await vi.waitFor(() => expect(runtime.sent).toEqual(['Answer: New API']))
    const t = await ticketOf(engine, ticket.id)
    expect(t.deferredDecisions).toEqual([])
    expect(t.state).toMatchObject({ column: 'in_progress', agentStatus: 'working', deferredUntil: null })
    // Its date coming changes nothing.
    await clock.advance(2 * DAY)
    expect((await ticketOf(engine, ticket.id)).pendingDecisions).toEqual([])
  })

  test('decision.bringBack returns it to pending now, and refuses one that is not deferred', async () => {
    const { engine, ticket, decision } = await asked()
    await expect(engine.invoke('decision.bringBack', decision.id)).rejects.toThrow('not deferred')
    await engine.invoke('decision.defer', decision.id, iso(1))
    await engine.invoke('decision.bringBack', decision.id)
    expect((await ticketOf(engine, ticket.id)).pendingDecisions.map((d) => d.id)).toEqual([decision.id])
    expect(clock.pending).toBe(0)
  })

  test('stopping the ticket expires a deferred decision and releases its hold', async () => {
    const { engine, ticket, decision } = await asked()
    await engine.invoke('decision.defer', decision.id, iso(1))
    await engine.invoke('agent.stop', ticket.id)
    const thread = await engine.invoke('thread.get', ticket.id)
    expect(thread.decisions.find((d) => d.id === decision.id)?.status).toBe('expired')
    await clock.advance(2 * DAY)
    expect((await ticketOf(engine, ticket.id)).pendingDecisions).toEqual([])
  })
})

describe('the orchestrator hears of decisions that came back', () => {
  test('its next message lists a decision whose date came', async () => {
    const { engine, runtime, decision } = await asked()
    await engine.invoke('orchestrator.send', 'Hello')
    await vi.waitFor(async () => expect((await engine.invoke('orchestrator.get')).status).toBe('idle'))
    await clock.advance(1000)
    await engine.invoke('decision.defer', decision.id, iso(1))
    await clock.advance(DAY)

    await engine.invoke('orchestrator.send', 'Anything new?')
    await vi.waitFor(() => expect(runtime.sent.length).toBeGreaterThan(0))
    const message = runtime.sent.at(-1)!
    expect(message).toContain('[Mainbus] Since your last turn, these decisions the user put off came back:')
    expect(message).toContain('"Which API?"')
    expect(message).toContain('deferred until 2026-11-03')
  })

  test('says nothing for a decision brought back by hand', async () => {
    const { engine, runtime, decision } = await asked()
    await engine.invoke('orchestrator.send', 'Hello')
    await vi.waitFor(async () => expect((await engine.invoke('orchestrator.get')).status).toBe('idle'))
    await clock.advance(1000)
    await engine.invoke('decision.defer', decision.id, iso(5))
    await engine.invoke('decision.bringBack', decision.id)
    await engine.invoke('orchestrator.send', 'Anything new?')
    await vi.waitFor(() => expect(runtime.sent.length).toBeGreaterThan(0))
    expect(runtime.sent.at(-1)).not.toContain('put off came back')
  })
})
