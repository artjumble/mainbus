import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runGit } from '../git/git'
import { FakeClock } from '../holds/clock'
import { resolveHome, type HomePaths } from '../home'
import { createEngine, type Engine } from '../index'
import { makeRepo } from '../intake/testBoard'
import { STUCK_HEADING } from '../orchestrator/stuckBlock'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import type { ExecFn } from '../runtime/resolveClaude'

// Each test starts an engine over a real repository: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

const START = new Date('2026-11-02T09:00:00.000Z')
const MIN = 60_000
const at = (minutes: number): string => new Date(START.getTime() + minutes * MIN).toISOString()

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]
let clock: FakeClock
let changed: number | null

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-stuck-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  engines = []
  clock = new FakeClock(START)
  changed = null
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const turnEnd = (): FakeStep => ({ emit: { kind: 'turn_end', ok: true } })
const ORCHESTRATOR: FakeStep[] = [
  { emit: { kind: 'session', sessionId: 's' } },
  turnEnd(),
  ...[1, 2, 3, 4, 5].flatMap((): FakeStep[] => [{ waitForSend: true }, turnEnd()])
]
const QUIET: FakeStep[] = [{ emit: { kind: 'session', sessionId: 'role-sess' } }, { waitForSend: true }]

/** The clock moves the stuck detector's checks as well as the engine's time, once a minute. */
async function makeEngine(runtime: FakeRuntime): Promise<Engine> {
  const engine = await createEngine({
    paths,
    migrationsDir,
    runtime,
    git: runGit,
    exec,
    clock,
    stuck: { timer: clock, newestChange: async () => changed }
  })
  engines.push(engine)
  await engine.invoke('workspace.open', repoPath)
  return engine
}

const newTicket = (engine: Engine) =>
  engine.invoke('ticket.create', { title: 'Login', intent: 'Add a login form', spec: '', criteria: [], labels: [], column: 'ready' })
const ticketOf = async (engine: Engine, id: string) => (await engine.invoke('board.get')).tickets.find((t) => t.id === id)!

async function started(runtime: FakeRuntime) {
  const engine = await makeEngine(runtime)
  const ticket = await newTicket(engine)
  await engine.invoke('agent.start', ticket.id)
  await vi.waitFor(() => expect(runtime.specs).toHaveLength(1))
  return { engine, ticket }
}

describe('report_waiting', () => {
  test('records the wait in the thread, and a bad time is refused with the reason', async () => {
    const runtime = new FakeRuntime(QUIET)
    const { engine, ticket } = await started(runtime)
    const { reportWaiting } = runtime.specs[0]!.roleTools

    expect(await reportWaiting({ reason: 'the full test suite', until: at(-1) })).toContain('not in the future')
    expect(await reportWaiting({ reason: 'the full test suite', until: at(121) })).toContain('at most 2 hours')
    expect(await reportWaiting({ reason: 'the full test suite', until: 'soon' })).toContain('ISO date-time')
    expect(await reportWaiting({ reason: '  ', until: at(10) })).toContain('say what you are waiting for')
    let thread = await engine.invoke('thread.get', ticket.id)
    expect(thread.events.filter((e) => e.event.kind === 'waiting')).toEqual([])

    expect(await reportWaiting({ reason: 'the full test suite', until: at(120) })).toContain('Recorded')
    thread = await engine.invoke('thread.get', ticket.id)
    expect(thread.events.map((e) => e.event)).toContainEqual({ kind: 'waiting', reason: 'the full test suite', until: at(120) })
  })

  test('a wait protects the agent until it ends; its silence then counts from there', async () => {
    const runtime = new FakeRuntime(QUIET)
    const { engine, ticket } = await started(runtime)
    await runtime.specs[0]!.roleTools.reportWaiting({ reason: 'a slow build', until: at(30) })

    await clock.advance(29 * MIN)
    expect((await ticketOf(engine, ticket.id)).stuck).toBeNull()
    await clock.advance(MIN)
    expect((await ticketOf(engine, ticket.id)).stuck).toBeNull()
    await clock.advance(9 * MIN)
    expect((await ticketOf(engine, ticket.id)).stuck).toBeNull()
    await clock.advance(MIN)
    expect((await ticketOf(engine, ticket.id)).stuck).toMatchObject({ rule: 'silence', hitCount: 1 })
  })

  test('calling it again replaces the wait', async () => {
    const runtime = new FakeRuntime(QUIET)
    const { engine, ticket } = await started(runtime)
    const { reportWaiting } = runtime.specs[0]!.roleTools
    await reportWaiting({ reason: 'a slow build', until: at(60) })
    await reportWaiting({ reason: 'the build is done', until: at(2) })
    await clock.advance(12 * MIN)
    // The first wait would have covered this; the second ended at minute 2, so ten quiet minutes later it is silence.
    expect((await ticketOf(engine, ticket.id)).stuck).toMatchObject({ rule: 'silence' })
  })

  test('handing off ends the wait', async () => {
    const runtime = new FakeRuntime(QUIET)
    const { engine, ticket } = await started(runtime)
    const { reportWaiting } = runtime.specs[0]!.roleTools
    await reportWaiting({ reason: 'a slow build', until: at(60) })
    // A worktree with nothing to commit: the handoff goes through.
    await runtime.specs[0]!.roleTools.handoff({ summary: 'done', notesForNext: '' })
    const [run] = await engine.invoke('thread.get', ticket.id).then((t) => t.runs)
    expect(run).toBeDefined()
    expect(await reportWaiting({ reason: 'again', until: at(10) })).toBe('This run has ended.')
  })
})

describe('a stuck agent on the board', () => {
  test('shows its episode with the evidence, grows it on repeats, and drops it when the agent makes progress', async () => {
    const runtime = new FakeRuntime(QUIET)
    const { engine, ticket } = await started(runtime)
    expect((await ticketOf(engine, ticket.id)).stuck).toBeNull()

    await clock.advance(10 * MIN)
    const first = (await ticketOf(engine, ticket.id)).stuck
    expect(first).toMatchObject({ rule: 'silence', hitCount: 1, needsCloserLook: false, evidence: ['No events from the agent for 10 minutes'] })

    // A repeat hit counts every five minutes, on the same episode.
    await clock.advance(5 * MIN)
    expect((await ticketOf(engine, ticket.id)).stuck).toMatchObject({ id: first!.id, hitCount: 2, needsCloserLook: false })
    await clock.advance(5 * MIN)
    expect((await ticketOf(engine, ticket.id)).stuck).toMatchObject({ id: first!.id, hitCount: 3, needsCloserLook: true })

    // A file changes in the worktree: that is progress, and the next check closes the episode.
    changed = clock.now().getTime() + 1
    await clock.advance(MIN)
    expect((await ticketOf(engine, ticket.id)).stuck).toBeNull()
  })

  test('is gone once the ticket is stopped', async () => {
    const runtime = new FakeRuntime(QUIET)
    const { engine, ticket } = await started(runtime)
    await clock.advance(10 * MIN)
    expect((await ticketOf(engine, ticket.id)).stuck).not.toBeNull()
    await engine.invoke('agent.stop', ticket.id)
    expect((await ticketOf(engine, ticket.id)).stuck).toBeNull()
  })

  test('a held ticket is not reported', async () => {
    const runtime = new FakeRuntime(QUIET)
    const { engine, ticket } = await started(runtime)
    await engine.invoke('ticket.hold', ticket.id, {})
    await clock.advance(30 * MIN)
    expect((await ticketOf(engine, ticket.id)).stuck).toBeNull()
  })

  test('a dead process is reported once, however many checks follow', async () => {
    const runtime = new FakeRuntime([{ emit: { kind: 'session', sessionId: 's' } }, { exit: 1 }])
    const { engine, ticket } = await started(runtime)
    await vi.waitFor(async () => expect((await engine.invoke('thread.get', ticket.id)).events.some((e) => e.event.kind === 'process_exit')).toBe(true))
    await clock.advance(MIN)
    const first = (await ticketOf(engine, ticket.id)).stuck
    expect(first).toMatchObject({ rule: 'dead_process', hitCount: 1 })
    await clock.advance(30 * MIN)
    expect((await ticketOf(engine, ticket.id)).stuck).toMatchObject({ id: first!.id, hitCount: 1 })
  })
})

describe('the orchestrator hears of stuck agents', () => {
  async function withOrchestrator() {
    const runtime = new FakeRuntime(QUIET, { orchestrator: ORCHESTRATOR })
    const engine = await makeEngine(runtime)
    const ticket = await newTicket(engine)
    await engine.invoke('orchestrator.send', 'Hello')
    await vi.waitFor(async () => expect((await engine.invoke('orchestrator.get')).status).toBe('idle'))
    await engine.invoke('agent.start', ticket.id)
    await vi.waitFor(() => expect(runtime.specs).toHaveLength(1))
    const say = async (text: string): Promise<string> => {
      const before = runtime.sent.length
      await engine.invoke('orchestrator.send', text)
      await vi.waitFor(() => expect(runtime.sent).toHaveLength(before + 1))
      await vi.waitFor(async () => expect((await engine.invoke('orchestrator.get')).status).toBe('idle'))
      return runtime.sent[before]!
    }
    return { runtime, engine, ticket, say }
  }

  test('its next turn lists an opened episode with its evidence, then each escalation, and nothing else', async () => {
    const { engine, ticket, say } = await withOrchestrator()
    await clock.advance(10 * MIN)
    expect((await ticketOf(engine, ticket.id)).stuck).toMatchObject({ hitCount: 1 })
    await clock.advance(MIN)

    const opened = await say('Anything new?')
    expect(opened).toContain(STUCK_HEADING)
    expect(opened).toContain(`#${ticket.number} "Login": the Planner looks stuck. Evidence`)
    expect(opened).toContain('<ticket-data field="stuck-evidence">No events from the agent for 10 minutes</ticket-data>')
    expect(opened).not.toContain('needs a closer look')

    // Nothing opened or escalated since: the block is gone.
    await clock.advance(MIN)
    expect(await say('And now?')).not.toContain(STUCK_HEADING)

    // The third hit escalates the episode, and that is news again.
    await clock.advance(10 * MIN)
    expect((await ticketOf(engine, ticket.id)).stuck).toMatchObject({ hitCount: 3, needsCloserLook: true })
    const escalated = await say('Anything else?')
    expect(escalated).toContain(STUCK_HEADING)
    expect(escalated).toContain('flagged 3 times and needs a closer look')
  })

  test('says nothing about an episode that has closed', async () => {
    const { engine, ticket, say } = await withOrchestrator()
    await clock.advance(10 * MIN)
    changed = clock.now().getTime() + 1
    await clock.advance(MIN)
    expect((await ticketOf(engine, ticket.id)).stuck).toBeNull()
    expect(await say('Anything new?')).not.toContain(STUCK_HEADING)
  })

  test('get_run_status shows the open episode and its evidence', async () => {
    const { runtime, engine, ticket, say } = await withOrchestrator()
    await say('Hi again')
    const { tools } = runtime.orchestratorSpecs[0]!
    expect(await tools.getRunStatus({ number: ticket.number })).not.toContain('Looks stuck')

    await clock.advance(10 * MIN)
    expect((await ticketOf(engine, ticket.id)).stuck).not.toBeNull()
    const status = await tools.getRunStatus({ number: ticket.number })
    expect(status).toContain('Looks stuck (opened ')
    expect(status).toContain('no events for a while')
    expect(status).toContain('<ticket-data field="stuck-evidence">No events from the agent for 10 minutes</ticket-data>')
  })
})
