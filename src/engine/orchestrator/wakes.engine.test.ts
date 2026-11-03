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
import { RELEASED_HEADING } from './releasedHoldsBlock'
import { WAKE_DEBOUNCE_MS } from './wakes'
import { WAKE_HEADING } from './wakeDigest'

// Each test starts an engine over a real repository: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

const START = new Date('2026-11-02T09:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const MINUTE = 60_000
const iso = (daysFromStart: number): string => new Date(START.getTime() + daysFromStart * DAY).toISOString()

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]
let clock: FakeClock

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-wakes-'))
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
const say = (text: string): FakeStep => ({ emit: { kind: 'message', text } })

/** A role whose agent fails twice in a row, which fails its run. */
const FAILING: FakeStep[] = [
  session('role-sess'),
  { emit: { kind: 'turn_end', ok: false, error: 'API is down' } },
  { emit: { kind: 'turn_end', ok: false, error: 'API is down' } }
]
const ASKING: FakeStep[] = [session('role-sess'), { callTool: 'askUser', args: { question: 'Which API?', options: ['Old API', 'New API'] } }, turnEnd(), { waitForSend: true }]
const QUIET: FakeStep[] = [session('role-sess'), { waitForSend: true }]

/** The orchestrator answers its launch turn, then one message of the user per segment. */
const ANSWERING: FakeStep[] = [session('orch'), say('Looking into it.'), turnEnd(), { waitForSend: true }, say('Hi.'), turnEnd(), { waitForSend: true }, turnEnd()]

async function makeEngine(runtime: FakeRuntime): Promise<Engine> {
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec, clock })
  engines.push(engine)
  await engine.invoke('workspace.open', repoPath)
  return engine
}

const newTicket = (engine: Engine, title = 'Login') =>
  engine.invoke('ticket.create', { title, intent: 'Add a login form', spec: '', criteria: [], labels: [], column: 'ready' })
const ticketOf = async (engine: Engine, id: string) => (await engine.invoke('board.get')).tickets.find((t) => t.id === id)!
const orchestratorOf = (engine: Engine) => engine.invoke('orchestrator.get')
const idle = (engine: Engine) => vi.waitFor(async () => expect((await orchestratorOf(engine)).status).toBe('idle'))

/** An engine with a started ticket whose agent failed. */
async function failed(orchestrator: FakeStep[] = ANSWERING) {
  const runtime = new FakeRuntime(FAILING, { orchestrator })
  const engine = await makeEngine(runtime)
  const ticket = await newTicket(engine)
  await engine.invoke('agent.start', ticket.id)
  await vi.waitFor(async () => expect((await ticketOf(engine, ticket.id)).state.agentStatus).toBe('failed'))
  return { engine, runtime, ticket }
}

/** A second launch of the app over the same data home. */
async function relaunch(first: Engine, orchestrator: FakeStep[] = ANSWERING) {
  await first.dispose()
  const runtime = new FakeRuntime(QUIET, { orchestrator })
  return { engine: await makeEngine(runtime), runtime }
}

describe('a failure', () => {
  test('gives the orchestrator a turn of its own after the debounce, with no message of the user', async () => {
    const { engine, runtime, ticket } = await failed()
    await clock.advance(WAKE_DEBOUNCE_MS - 1)
    expect(runtime.orchestratorSpecs).toHaveLength(0)
    await clock.advance(1)
    await vi.waitFor(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    await idle(engine)

    const prompt = runtime.orchestratorSpecs[0]!.prompt
    expect(prompt).toContain(WAKE_HEADING)
    expect(prompt).toContain(`#${ticket.number} "Login" (workspace "repo"): the Planner's run failed and the ticket moved to Needs you.`)
    expect(prompt).toContain('<ticket-data field="failure-error">API is down</ticket-data>')
    expect(prompt).toContain('Open decisions: none.')
    expect(prompt).toContain('idempotently')

    const thread = await orchestratorOf(engine)
    const kinds = thread.events.map((e) => e.event.kind)
    expect(kinds).not.toContain('user_message')
    expect(thread.events.map((e) => e.event)).toContainEqual({ kind: 'wake', items: [`#${ticket.number} "Login" (workspace "repo"): the Planner failed`] })
    expect(thread.events.map((e) => e.event)).toContainEqual({ kind: 'message', text: 'Looking into it.' })
  })

  test('can be answered with a proposal, once: the same proposal made again is the pending one, with no second card', async () => {
    const hold = { callTool: 'proposeHold', args: { ticket: 1, reason: 'Wait for the API to come back' } } as const
    const { engine, runtime } = await failed([session('orch'), hold, hold, turnEnd()])
    await clock.advance(WAKE_DEBOUNCE_MS)
    await vi.waitFor(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    await idle(engine)
    const thread = await orchestratorOf(engine)
    expect(thread.proposals).toHaveLength(1)
    expect(thread.proposals[0]).toMatchObject({ kind: 'hold', status: 'pending', origin: 'orchestrator' })
    expect(thread.events.filter((e) => e.event.kind === 'proposal')).toHaveLength(1)
  })

  test('cannot draft tickets: that needs a message of the user', async () => {
    const draft = { callTool: 'proposeCreateTickets', args: { tickets: [{ title: 'Another' }] } } as const
    const { engine, runtime } = await failed([session('orch'), draft, turnEnd()])
    await clock.advance(WAKE_DEBOUNCE_MS)
    await vi.waitFor(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    await idle(engine)
    expect((await orchestratorOf(engine)).proposals).toEqual([])
  })

  test('is acknowledged once the turn finished: the next launch presents nothing', async () => {
    const { engine, ticket } = await failed()
    await clock.advance(WAKE_DEBOUNCE_MS)
    await vi.waitFor(async () => expect((await orchestratorOf(engine)).events.map((e) => e.event.kind)).toContain('turn_end'))
    await idle(engine)

    const second = await relaunch(engine)
    await clock.advance(10 * MINUTE)
    expect(second.runtime.orchestratorSpecs).toHaveLength(0)
    expect((await ticketOf(second.engine, ticket.id)).state.agentStatus).toBe('failed')
  })

  test('is not presented while a turn is running, and the same failure is never added twice', async () => {
    const { engine, runtime } = await failed([session('orch')])
    await clock.advance(WAKE_DEBOUNCE_MS)
    await vi.waitFor(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    await clock.advance(10 * MINUTE)
    // The turn never ended, and the row was not added again: nothing else was sent to it.
    expect(runtime.orchestratorSpecs).toHaveLength(1)
    expect(runtime.sent).toEqual([])
    expect((await orchestratorOf(engine)).status).toBe('working')
  })
})

describe('a wake turn that does not finish', () => {
  test('that fails leaves the rows pending, does not start another by itself, and is presented again at the next launch', async () => {
    const { engine, runtime, ticket } = await failed([session('orch'), { emit: { kind: 'turn_end', ok: false, error: 'boom' } }])
    await clock.advance(WAKE_DEBOUNCE_MS)
    await vi.waitFor(async () => expect((await orchestratorOf(engine)).status).toBe('failed'))
    await clock.advance(30 * MINUTE)
    expect(runtime.orchestratorSpecs).toHaveLength(1)
    expect(runtime.sent).toEqual([])

    const second = await relaunch(engine)
    await clock.advance(WAKE_DEBOUNCE_MS)
    await vi.waitFor(() => expect(second.runtime.orchestratorSpecs).toHaveLength(1))
    await idle(second.engine)
    expect(second.runtime.orchestratorSpecs[0]!.prompt).toContain(`#${ticket.number} "Login" (workspace "repo"): the Planner's run failed`)
    // Resumed, as any later message would: the same run of the orchestrator.
    expect(second.runtime.orchestratorSpecs[0]!.resumeSessionId).toBe('orch')
  })

  test('that the app was closed in the middle of is presented again, the same row, at the next launch', async () => {
    const { engine, runtime, ticket } = await failed([session('orch')])
    await clock.advance(WAKE_DEBOUNCE_MS)
    await vi.waitFor(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    const digest = runtime.orchestratorSpecs[0]!.prompt.slice(runtime.orchestratorSpecs[0]!.prompt.indexOf(WAKE_HEADING))

    const second = await relaunch(engine)
    await clock.advance(WAKE_DEBOUNCE_MS)
    await vi.waitFor(() => expect(second.runtime.orchestratorSpecs).toHaveLength(1))
    await idle(second.engine)
    const again = second.runtime.orchestratorSpecs[0]!.prompt
    expect(again).toContain(`#${ticket.number} "Login" (workspace "repo"): the Planner's run failed`)
    expect(again).toContain(digest.split('\n').slice(0, 2).join('\n'))
    const wakes = (await orchestratorOf(second.engine)).events.filter((e) => e.event.kind === 'wake')
    expect(wakes).toHaveLength(2)

    // This time it finished: nothing is left for a third launch.
    const third = await relaunch(second.engine)
    await clock.advance(10 * MINUTE)
    expect(third.runtime.orchestratorSpecs).toHaveLength(0)
  })

  test('that the user stopped leaves the rows pending too', async () => {
    const runtime = new FakeRuntime(FAILING, { orchestrator: [session('orch')], endTurnOnInterrupt: true })
    const engine = await makeEngine(runtime)
    const ticket = await newTicket(engine)
    await engine.invoke('agent.start', ticket.id)
    await vi.waitFor(async () => expect((await ticketOf(engine, ticket.id)).state.agentStatus).toBe('failed'))
    await clock.advance(WAKE_DEBOUNCE_MS)
    await vi.waitFor(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    await engine.invoke('orchestrator.stop')
    await idle(engine)
    await clock.advance(30 * MINUTE)
    expect(runtime.sent).toEqual([])

    const second = await relaunch(engine)
    await clock.advance(WAKE_DEBOUNCE_MS)
    await vi.waitFor(() => expect(second.runtime.orchestratorSpecs).toHaveLength(1))
    expect(second.runtime.orchestratorSpecs[0]!.prompt).toContain('the Planner\'s run failed')
  })
})

describe('a hold released by its date', () => {
  test('gives a turn; the next message of the user does not repeat it, but a hold released by hand is still reported to it', async () => {
    const runtime = new FakeRuntime(QUIET, { orchestrator: ANSWERING })
    const engine = await makeEngine(runtime)
    const byDate = await newTicket(engine, 'By date')
    const byHand = await newTicket(engine, 'By hand')
    await engine.invoke('ticket.hold', byDate.id, { until: iso(1) })
    await engine.invoke('ticket.hold', byHand.id)

    await clock.advance(DAY)
    await clock.advance(WAKE_DEBOUNCE_MS)
    await vi.waitFor(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    await idle(engine)
    expect(runtime.orchestratorSpecs[0]!.prompt).toContain(`#${byDate.number} "By date" (workspace "repo") is no longer held (its date, ${iso(1).slice(0, 10)}, came). It can be started again.`)

    // The user releasing a hold gives no turn: they know.
    await engine.invoke('ticket.unhold', byHand.id)
    await clock.advance(10 * MINUTE)
    expect(runtime.sent).toEqual([])

    await engine.invoke('orchestrator.send', 'Anything new?')
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
    const message = runtime.sent[0]!
    expect(message).toContain(RELEASED_HEADING)
    expect(message).toContain(`#${byHand.number} "By hand" (workspace "repo") is no longer held`)
    expect(message).not.toContain('By date')
  })
})

describe('a deferred decision that comes back on its date', () => {
  async function deferred() {
    const runtime = new FakeRuntime(ASKING, { orchestrator: ANSWERING })
    const engine = await makeEngine(runtime)
    const ticket = await newTicket(engine)
    await engine.invoke('agent.start', ticket.id)
    await vi.waitFor(async () => expect((await ticketOf(engine, ticket.id)).pendingDecisions).toHaveLength(1))
    const [decision] = (await ticketOf(engine, ticket.id)).pendingDecisions
    await engine.invoke('decision.defer', decision!.id, iso(1))
    return { engine, runtime, ticket, decision: decision! }
  }

  test('gives a turn with the decision, which is among every open decision of the workspace', async () => {
    const { engine, runtime, ticket, decision } = await deferred()
    await clock.advance(DAY)
    await clock.advance(WAKE_DEBOUNCE_MS)
    await vi.waitFor(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    await idle(engine)
    const prompt = runtime.orchestratorSpecs[0]!.prompt
    expect(prompt).toContain(`#${ticket.number} "Login" (workspace "repo"): <ticket-data field="question">Which API?</ticket-data> is waiting on the user again (decision ${decision.id}).`)
    expect(prompt).toContain('Open decisions (all that are waiting or put off):')
    expect(prompt).toContain(`- #${ticket.number} "Login" (workspace "repo") (decision ${decision.id}, waiting on the user): <ticket-data field="question">Which API?</ticket-data>`)
  })

  test('is not told twice: the next message of the user leaves it out', async () => {
    const { engine, runtime } = await deferred()
    await clock.advance(DAY)
    await clock.advance(WAKE_DEBOUNCE_MS)
    await vi.waitFor(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    await idle(engine)
    await engine.invoke('orchestrator.send', 'And now?')
    await vi.waitFor(() => expect(runtime.sent.some((s) => s.includes('And now?'))).toBe(true))
    expect(runtime.sent.find((s) => s.includes('And now?'))).not.toContain('these decisions the user put off came back')
  })

  test('brought back by hand gives no turn', async () => {
    const { engine, runtime, decision } = await deferred()
    await engine.invoke('decision.bringBack', decision.id)
    await clock.advance(DAY + 10 * MINUTE)
    expect(runtime.orchestratorSpecs).toHaveLength(0)
  })
})

describe('nothing to say', () => {
  test('a launch with no news starts no turn and sets no timer', async () => {
    const runtime = new FakeRuntime(QUIET, { orchestrator: ANSWERING })
    await makeEngine(runtime)
    expect(clock.pending).toBe(0)
    await clock.advance(DAY)
    expect(runtime.orchestratorSpecs).toHaveLength(0)
  })
})

describe('two workspaces', () => {
  test('a failure in the workspace that is not focused still wakes the orchestrator, and names its workspace', async () => {
    const runtime = new FakeRuntime(FAILING, { orchestrator: ANSWERING })
    const engine = await makeEngine(runtime)
    const ticket = await newTicket(engine)
    await engine.invoke('agent.start', ticket.id)
    await vi.waitFor(async () => expect((await ticketOf(engine, ticket.id)).state.agentStatus).toBe('failed'))
    // Another repo is opened and focused while the failure waits for the debounce.
    await engine.invoke('workspace.open', await makeRepo(path.join(tmp, 'other')))

    await clock.advance(WAKE_DEBOUNCE_MS)
    await vi.waitFor(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    const prompt = runtime.orchestratorSpecs[0]!.prompt
    expect(prompt).toContain('Focused workspace: other')
    expect(prompt).toContain(`#${ticket.number} "Login" (workspace "repo"): the Planner's run failed`)
  })
})
