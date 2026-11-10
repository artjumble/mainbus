import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent } from '../../shared/api'
import type { Ticket } from '../../shared/domain'
import type { ThreadEvent } from '../../shared/events'
import { usagePauseReason } from '../../shared/usage'
import { runGit } from '../git/git'
import { WorktreeManager } from '../git/worktrees'
import { resolveHome, type HomePaths } from '../home'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import type { RunSpec } from '../runtime/types'
import { createRepos, type Repos } from '../store'
import { FIXED_NOW, implementerOnly, openTestDb } from '../store/testDb'
import { testUsage, type TestUsage } from './testUsage'
import { TicketRunner, USAGE_RESUME_TEXT } from './ticketRunner'
import { eventually } from '../testWait'

let tmp: string
let repoPath: string
let paths: HomePaths
let closeDb: () => void
let repos: Repos
let worktrees: WorktreeManager
let workspaceId: string
let emitted: EngineEvent[]
let runners: TicketRunner[]
let tickets: Ticket[]

const RESET_AT = FIXED_NOW.getTime() + 3_600_000

async function git(args: string[]): Promise<void> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], repoPath)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}

const rejected = (resetsAt?: number): FakeStep => ({
  emit: { kind: 'rate_limit', status: 'rejected', ...(resetsAt === undefined ? {} : { resetsAt: Math.floor(resetsAt / 1000) }), windows: {} }
})
const windowAt = (utilization: number, status: string): FakeStep => ({
  emit: { kind: 'rate_limit', status, windows: { five_hour: { utilization, resetsAt: Math.floor(RESET_AT / 1000), status } } }
})
const sessionStep = (spec: RunSpec): FakeStep => ({ emit: { kind: 'session', sessionId: `session-${spec.cwd}` } })
const HANDOFF: FakeStep[] = [{ callTool: 'handoff', args: { summary: 'done', notesForNext: '' } }, { emit: { kind: 'turn_end', ok: true } }]

/** Ticket A runs into the limit when it is sent a message; every other ticket just works until it is sent one, then hands off. */
function fleetScript(opts: { hit?: FakeStep[]; resumed?: (spec: RunSpec) => FakeStep[] } = {}): (spec: RunSpec) => FakeStep[] {
  const hit = opts.hit ?? [rejected(RESET_AT), { emit: { kind: 'turn_end', ok: false, error: 'Claude AI usage limit reached' } }]
  return (spec) => {
    if (spec.resumeSessionId) return opts.resumed ? opts.resumed(spec) : [sessionStep(spec), { waitForSend: true }, ...HANDOFF]
    return spec.cwd.endsWith('-a') ? [sessionStep(spec), { waitForSend: true }, ...hit, { waitForSend: true }] : [sessionStep(spec), { waitForSend: true }, ...HANDOFF]
  }
}

function makeRunner(runtime: FakeRuntime, usage: TestUsage): TicketRunner {
  const runner = new TicketRunner({
    repos,
    worktrees,
    runtime,
    now: () => FIXED_NOW,
    emit: (e) => emitted.push(e),
    usage: usage.hooks
  })
  usage.attach(runner)
  runners.push(runner)
  return runner
}

async function newTicket(title: string): Promise<Ticket> {
  const t = await repos.tickets.create({ workspaceId, title, intent: title, spec: '', criteria: [], labels: [], column: 'ready' })
  tickets.push(t)
  return t
}

async function waitForStatus(runner: TicketRunner, t: Ticket, agentStatus: string | null): Promise<void> {
  await waitFor(async () => {
    expect((await runner.stateOf(t.id)).agentStatus).toBe(agentStatus)
    expect(runner.isLaunching(t.id)).toBe(false)
  })
}

async function waitForLimitPause(runner: TicketRunner, ...ts: Ticket[]): Promise<void> {
  for (const t of ts) {
    await waitFor(async () => expect(await runner.stateOf(t.id)).toMatchObject({ agentStatus: 'paused', pausedByLimit: true }))
  }
}

async function threadOf(t: Ticket): Promise<ThreadEvent[]> {
  const run = await repos.runs.latest(t.id)
  return run ? (await repos.runs.events(run.id)).map((e) => e.event) : []
}

/** The tickets A and B working, with their agents waiting for a message. */
async function twoWorking(runtime: FakeRuntime, usage: TestUsage, cap = 3): Promise<{ runner: TicketRunner; a: Ticket; b: Ticket }> {
  await repos.settings.setMaxAgents(cap)
  const runner = makeRunner(runtime, usage)
  const [a, b] = [await newTicket('A'), await newTicket('B')]
  await runner.start(a.id)
  await runner.start(b.id)
  // Both agents are up, and their sessions are known (a paused agent resumes by its session).
  for (const t of [a, b]) await waitFor(async () => expect((await repos.runs.latest(t.id))?.sessionId).not.toBeNull())
  return { runner, a, b }
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-fleet-'))
  repoPath = path.join(tmp, 'repo')
  await fs.mkdir(repoPath)
  await git(['init', '-b', 'main'])
  await fs.writeFile(path.join(repoPath, 'README.md'), 'hello\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'initial'])
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  const testDb = await openTestDb()
  closeDb = testDb.cleanup
  repos = createRepos(testDb.db, () => FIXED_NOW)
  worktrees = new WorktreeManager(runGit, paths, repos.cleanups)
  const ws = await repos.workspaces.create(repoPath, 'main', 'repo', 'repo')
  workspaceId = ws.id
  await implementerOnly(repos.lineups, ws.id)
  emitted = []
  runners = []
  tickets = []
})

afterEach(async () => {
  for (const runner of runners) for (const t of tickets) await runner.stop(t.id).catch(() => {})
  closeDb()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
})

vi.setConfig({ testTimeout: 30_000 })

/** vi.waitFor with room for a loaded machine: a launch makes a git worktree. */
const waitFor: typeof vi.waitFor = (fn, options) => eventually(fn, { timeout: 10_000, ...(typeof options === 'object' ? options : {}) })

describe('a usage limit pauses the whole fleet', () => {
  it('pauses every working agent with the reason, in the order they were paused, and nothing needs the user', async () => {
    const usage = testUsage(repos, (e) => emitted.push(e))
    const runtime = new FakeRuntime(fleetScript())
    const { runner, a, b } = await twoWorking(runtime, usage)
    await waitFor(() => expect(runtime.specs).toHaveLength(2))

    await runner.send(a.id, 'go')
    await waitForLimitPause(runner, a, b)

    const reason = usagePauseReason({ kind: 'limited', resetsAt: new Date(RESET_AT).toISOString(), retryAt: null, paused: 2 })
    for (const t of [a, b]) {
      expect(await runner.stateOf(t.id)).toMatchObject({ column: 'in_progress', agentStatus: 'paused', pausedByLimit: true, canContinue: false, summary: reason })
      const thread = await threadOf(t)
      expect(thread).toContainEqual({ kind: 'notice', text: reason })
      // Not a failure, a stuck agent or an agent that went quiet.
      expect(thread.map((e) => e.kind)).not.toContain('process_exit')
      expect(thread.map((e) => e.kind)).not.toContain('nudge')
      expect(thread.map((e) => e.kind)).not.toContain('error')
      expect((await repos.runs.latest(t.id))?.endReason).toBeNull()
    }
    expect((await repos.runs.limitPaused()).map((r) => r.ticketId)).toEqual([a.id, b.id])
    expect(await usage.gate.state()).toEqual({ kind: 'limited', resetsAt: new Date(RESET_AT).toISOString(), retryAt: null, paused: 2 })
    expect(await repos.settings.usageLimit()).toMatchObject({ resetsAt: new Date(RESET_AT).toISOString() })
    expect(emitted.some((e) => e.type === 'usage.changed' && e.state.kind === 'limited')).toBe(true)
  })

  it('leaves an agent that is only waiting on a decision alone', async () => {
    const usage = testUsage(repos)
    const runtime = new FakeRuntime((spec) =>
      spec.cwd.endsWith('-c')
        ? [sessionStep(spec), { callTool: 'askUser', args: { question: 'Which one?', options: ['x', 'y'] } }, { emit: { kind: 'turn_end', ok: true } }]
        : fleetScript()(spec)
    )
    const { runner, a, b } = await twoWorking(runtime, usage)
    const c = await newTicket('C')
    await runner.start(c.id)
    await waitForStatus(runner, c, 'waiting_on_you')

    await runner.send(a.id, 'go')
    await waitForLimitPause(runner, a, b)

    expect(await runner.stateOf(c.id)).toMatchObject({ column: 'needs_you', agentStatus: 'waiting_on_you' })
    expect((await repos.runs.limitPaused()).map((r) => r.ticketId)).toEqual([a.id, b.id])
  })

  it('enters the state from error text alone, with no reset time and a time to try again', async () => {
    const usage = testUsage(repos)
    const runtime = new FakeRuntime(fleetScript({ hit: [{ emit: { kind: 'turn_end', ok: false, error: "You've hit your limit · resets 3pm" } }] }))
    const { runner, a, b } = await twoWorking(runtime, usage)
    await waitFor(() => expect(runtime.specs).toHaveLength(2))

    await runner.send(a.id, 'go')
    await waitForLimitPause(runner, a, b)

    const retryAt = new Date(FIXED_NOW.getTime() + 15 * 60_000).toISOString()
    expect(await usage.gate.state()).toEqual({ kind: 'limited', resetsAt: null, retryAt, paused: 2 })
    expect((await runner.stateOf(a.id)).summary).toBe(usagePauseReason({ kind: 'limited', resetsAt: null, retryAt, paused: 2 }))
    expect((await threadOf(a)).map((e) => e.kind)).not.toContain('nudge')
  })

  it('keeps queued agents queued, then resumes the paused ones first, in order, through the cap', async () => {
    const usage = testUsage(repos)
    const runtime = new FakeRuntime(
      fleetScript({
        resumed: (spec) => [sessionStep(spec), { waitForSend: true }, ...HANDOFF]
      })
    )
    const { runner, a, b } = await twoWorking(runtime, usage, 2)
    const c = await newTicket('C')
    await runner.start(c.id)
    await waitForStatus(runner, c, 'queued')
    // Lowering the cap stops nothing: A and B keep working, and now only one may run at once.
    await repos.settings.setMaxAgents(1)

    await runner.send(a.id, 'go')
    await waitForLimitPause(runner, a, b)
    expect(await runner.stateOf(c.id)).toMatchObject({ agentStatus: 'queued', queuePosition: 1 })
    expect(runtime.specs).toHaveLength(2)

    await usage.clock.advance(3_600_000)

    // A, paused first, resumes first; B waits behind it and C behind B.
    await waitFor(() => expect(runtime.specs).toHaveLength(3))
    expect(runtime.specs[2]).toMatchObject({ resumeSessionId: `session-${runtime.specs[0]!.cwd}`, prompt: USAGE_RESUME_TEXT })
    await waitForStatus(runner, a, 'working')
    expect(await runner.stateOf(b.id)).toMatchObject({ agentStatus: 'queued', queuePosition: 1 })
    expect((await runner.stateOf(b.id)).pausedByLimit).toBeFalsy()
    expect(await runner.stateOf(c.id)).toMatchObject({ agentStatus: 'queued', queuePosition: 2 })
    expect(await usage.gate.state()).toEqual({ kind: 'ok' })
    expect(await repos.settings.usageLimit()).toBeNull()

    await runner.send(a.id, 'finish')
    await waitForStatus(runner, a, 'handed_off')
    await waitFor(() => expect(runtime.specs).toHaveLength(4))
    expect(runtime.specs[3]).toMatchObject({ prompt: USAGE_RESUME_TEXT })
    await waitForStatus(runner, b, 'working')
    expect(await runner.stateOf(c.id)).toMatchObject({ agentStatus: 'queued', queuePosition: 1 })
  })

  it('with no known reset, one agent tries every 15 minutes and the rest resume only once it gets through', async () => {
    const usage = testUsage(repos)
    const runtime = new FakeRuntime(
      fleetScript({
        hit: [{ emit: { kind: 'turn_end', ok: false, error: 'Claude AI usage limit reached' } }],
        resumed: (spec) => [sessionStep(spec), { waitForSend: true }, windowAt(0.1, 'allowed'), { waitForSend: true }]
      })
    )
    const { runner, a, b } = await twoWorking(runtime, usage)
    await waitFor(() => expect(runtime.specs).toHaveLength(2))
    await runner.send(a.id, 'go')
    await waitForLimitPause(runner, a, b)

    await usage.clock.advance(15 * 60_000)

    // Only A, the first paused, tries.
    await waitFor(() => expect(runtime.specs).toHaveLength(3))
    await waitForStatus(runner, a, 'working')
    expect(await runner.stateOf(b.id)).toMatchObject({ agentStatus: 'paused', pausedByLimit: true })
    expect(await usage.gate.state()).toMatchObject({ kind: 'limited', paused: 1 })

    // It gets an answer from the API: the limit is over, and B resumes.
    await runner.send(a.id, 'try')
    await waitFor(() => expect(runtime.specs).toHaveLength(4))
    await waitForStatus(runner, b, 'working')
    expect(await usage.gate.state()).toEqual({ kind: 'ok' })
  })

  it('Resume on a paused ticket tries early; Continue refuses it', async () => {
    const usage = testUsage(repos)
    const runtime = new FakeRuntime(fleetScript({ resumed: (spec) => [sessionStep(spec), windowAt(0.2, 'allowed'), { waitForSend: true }] }))
    const { runner, a, b } = await twoWorking(runtime, usage)
    await waitFor(() => expect(runtime.specs).toHaveLength(2))
    await runner.send(a.id, 'go')
    await waitForLimitPause(runner, a, b)

    await expect(runner.continue(b.id)).rejects.toThrow('Paused by the usage limit: use Resume to continue it now')
    expect(runtime.specs).toHaveLength(2)

    await runner.resumePaused(b.id)

    // B got through, so the limit is over for everyone: A resumes too.
    await waitForStatus(runner, b, 'working')
    await waitForStatus(runner, a, 'working')
    expect(await usage.gate.state()).toEqual({ kind: 'ok' })
    expect(runtime.specs).toHaveLength(4)
  })

  it("the banner's Resume now resumes everything at once, even before the reset", async () => {
    const usage = testUsage(repos)
    const runtime = new FakeRuntime(fleetScript())
    const { runner, a, b } = await twoWorking(runtime, usage)
    await waitFor(() => expect(runtime.specs).toHaveLength(2))
    await runner.send(a.id, 'go')
    await waitForLimitPause(runner, a, b)

    await usage.gate.resumeNow()

    await waitForStatus(runner, a, 'working')
    await waitForStatus(runner, b, 'working')
    expect(await usage.gate.state()).toEqual({ kind: 'ok' })
    expect(await repos.runs.limitPaused()).toEqual([])
  })

  it('a limit that is hit again while resuming starts a new wait', async () => {
    const usage = testUsage(repos)
    let resumes = 0
    const runtime = new FakeRuntime(
      fleetScript({
        resumed: (spec) => {
          resumes++
          return resumes === 1
            ? [sessionStep(spec), rejected(RESET_AT + 3_600_000), { emit: { kind: 'turn_end', ok: false, error: 'usage limit reached' } }, { waitForSend: true }]
            : [sessionStep(spec), { waitForSend: true }]
        }
      })
    )
    const { runner, a, b } = await twoWorking(runtime, usage)
    await waitFor(() => expect(runtime.specs).toHaveLength(2))
    await runner.send(a.id, 'go')
    await waitForLimitPause(runner, a, b)

    await usage.clock.advance(3_600_000)
    // Both resume at once (the cap allows it), and A's agent runs into the limit again: both are paused again.
    await waitFor(() => expect(runtime.specs).toHaveLength(4))
    await waitFor(async () => expect(await usage.gate.state()).toMatchObject({ resetsAt: new Date(RESET_AT + 3_600_000).toISOString() }))
    await waitForLimitPause(runner, a, b)
    expect(await usage.gate.state()).toEqual({
      kind: 'limited',
      resetsAt: new Date(RESET_AT + 3_600_000).toISOString(),
      retryAt: null,
      paused: 2
    })
    expect(runtime.specs).toHaveLength(4)

    await usage.clock.advance(3_600_000)
    await waitFor(() => expect(runtime.specs).toHaveLength(6))
    await waitForStatus(runner, a, 'working')
    await waitForStatus(runner, b, 'working')
  })
})

describe('the early warning', () => {
  it('holds new agents as Queued while the running one continues, and lets them go when utilization falls', async () => {
    const usage = testUsage(repos)
    const runtime = new FakeRuntime((spec) =>
      spec.cwd.endsWith('-a')
        ? [sessionStep(spec), windowAt(0.95, 'allowed_warning'), { waitForSend: true }, windowAt(0.3, 'allowed'), { waitForSend: true }]
        : [sessionStep(spec), { waitForSend: true }]
    )
    const runner = makeRunner(runtime, usage)
    const [a, b] = [await newTicket('A'), await newTicket('B')]
    await runner.start(a.id)
    await waitFor(() => expect(usage.gate.blocksStarts()).toBe(true))
    expect(await usage.gate.state()).toEqual({ kind: 'warning', resetsAt: new Date(RESET_AT).toISOString() })

    await runner.start(b.id)

    expect(await runner.stateOf(b.id)).toMatchObject({ column: 'in_progress', agentStatus: 'queued', queuePosition: 1 })
    expect(runtime.specs).toHaveLength(1)
    expect(await runner.stateOf(a.id)).toMatchObject({ agentStatus: 'working' })

    await runner.send(a.id, 'on')
    await waitForStatus(runner, b, 'working')
    expect(await usage.gate.state()).toEqual({ kind: 'ok' })
    expect(await runner.stateOf(a.id)).toMatchObject({ agentStatus: 'working' })
  })

  it('clears when the window resets', async () => {
    const usage = testUsage(repos)
    const runtime = new FakeRuntime((spec) => (spec.cwd.endsWith('-a') ? [sessionStep(spec), windowAt(0.92, 'allowed_warning'), { waitForSend: true }] : [sessionStep(spec), { waitForSend: true }]))
    const runner = makeRunner(runtime, usage)
    const [a, b] = [await newTicket('A'), await newTicket('B')]
    await runner.start(a.id)
    await waitFor(() => expect(usage.gate.blocksStarts()).toBe(true))
    await runner.start(b.id)
    expect(await runner.stateOf(b.id)).toMatchObject({ agentStatus: 'queued' })

    await usage.clock.advance(3_600_000)

    await waitForStatus(runner, b, 'working')
    expect(await usage.gate.state()).toEqual({ kind: 'ok' })
  })
})

describe('a restart', () => {
  it('keeps the state and the paused agents, restarts none of them, and resumes them at the reset', async () => {
    const usage = testUsage(repos)
    const runtime = new FakeRuntime(fleetScript())
    const { runner, a, b } = await twoWorking(runtime, usage)
    await waitFor(() => expect(runtime.specs).toHaveLength(2))
    await runner.send(a.id, 'go')
    await waitForLimitPause(runner, a, b)
    await runner.shutdown()
    usage.gate.dispose()

    // The app starts again on the same database, a little later.
    const again = testUsage(repos)
    const runtime2 = new FakeRuntime(fleetScript())
    const runner2 = makeRunner(runtime2, again)
    await again.gate.load()
    await runner2.markAllNotAlive()
    await runner2.recover({ resume: true })
    await again.gate.start()
    await runner2.queueSettled()

    expect(runtime2.specs).toHaveLength(0)
    expect(await again.gate.state()).toMatchObject({ kind: 'limited', paused: 2 })
    expect(await runner2.stateOf(a.id)).toMatchObject({ agentStatus: 'paused', pausedByLimit: true })
    expect(await runner2.stateOf(b.id)).toMatchObject({ agentStatus: 'paused', pausedByLimit: true })

    await again.clock.advance(3_600_000)
    await waitFor(() => expect(runtime2.specs).toHaveLength(2))
    expect(runtime2.specs.map((s) => s.prompt)).toEqual([USAGE_RESUME_TEXT, USAGE_RESUME_TEXT])
    await waitForStatus(runner2, a, 'working')
    await waitForStatus(runner2, b, 'working')
  })

  it('resumes the agents at once when the reset passed while the app was closed', async () => {
    const usage = testUsage(repos)
    const runtime = new FakeRuntime(fleetScript())
    const { runner, a, b } = await twoWorking(runtime, usage)
    await waitFor(() => expect(runtime.specs).toHaveLength(2))
    await runner.send(a.id, 'go')
    await waitForLimitPause(runner, a, b)
    await runner.shutdown()
    usage.gate.dispose()

    const again = testUsage(repos)
    await again.clock.advance(2 * 3_600_000)
    const runtime2 = new FakeRuntime(fleetScript())
    const runner2 = makeRunner(runtime2, again)
    await again.gate.load()
    await runner2.recover({ resume: true })
    await again.gate.start()

    await waitFor(() => expect(runtime2.specs).toHaveLength(2))
    expect(await again.gate.state()).toEqual({ kind: 'ok' })
  })
})
