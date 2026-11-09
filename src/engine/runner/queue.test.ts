import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent } from '../../shared/api'
import type { Ticket } from '../../shared/domain'
import { runGit } from '../git/git'
import { WorktreeManager } from '../git/worktrees'
import { resolveHome, type HomePaths } from '../home'
import { firstMessage } from '../roles/prompt'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import type { RunSpec } from '../runtime/types'
import { createRepos, type Repos } from '../store'
import { defaultLineup } from '../store/lineups'
import { FIXED_NOW, implementerOnly, openTestDb } from '../store/testDb'
import { testUsage, type TestUsage } from './testUsage'
import { TicketRunner } from './ticketRunner'

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

async function git(args: string[], cwd = repoPath): Promise<void> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}

/** An agent that stays open until it is sent a message, then hands off. */
function handsOffWhenSent(spec: RunSpec): FakeStep[] {
  const role = /## Your role: (.+)/.exec(spec.appendSystemPrompt)![1]!
  return [
    { emit: { kind: 'session', sessionId: `session-${spec.cwd}-${role}` } },
    { waitForSend: true },
    { callTool: 'handoff', args: { summary: `${role} summary`, notesForNext: '' } },
    { emit: { kind: 'turn_end', ok: true } }
  ]
}

function makeRunner(runtime: FakeRuntime, opts: { unattended?: boolean; usage?: TestUsage } = {}): TicketRunner {
  const runner = new TicketRunner({
    repos,
    worktrees,
    runtime,
    now: () => FIXED_NOW,
    emit: (e) => emitted.push(e),
    unattended: () => opts.unattended ?? false,
    ...(opts.usage ? { usage: opts.usage.hooks } : {})
  })
  opts.usage?.attach(runner)
  runners.push(runner)
  return runner
}

async function newTicket(title: string): Promise<Ticket> {
  const t = await repos.tickets.create({ workspaceId, title, intent: title, spec: '', criteria: [], labels: [], column: 'ready' })
  tickets.push(t)
  return t
}

const stateOf = (runner: TicketRunner, t: Ticket) => runner.stateOf(t.id)

/** Waits for the ticket to be in the given agent status. */
async function waitForStatus(runner: TicketRunner, t: Ticket, agentStatus: string | null): Promise<void> {
  await vi.waitFor(async () => {
    expect((await runner.stateOf(t.id)).agentStatus).toBe(agentStatus)
    // A launch under way shows as working before its process exists.
    expect(runner.isLaunching(t.id)).toBe(false)
  })
}

/** Sends the ticket's live agent a message, which makes it hand off; waits for the run to end. */
async function finish(runner: TicketRunner, t: Ticket): Promise<void> {
  await runner.send(t.id, 'finish')
  await waitForStatus(runner, t, 'handed_off')
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-queue-'))
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

// Each ticket makes a git worktree, so a test with several is slow when the whole suite runs at once.
vi.setConfig({ testTimeout: 30_000 })

describe('the cap on agents running at once', () => {
  it('lets three agents run by default and queues the fourth, in progress with its phase unchanged', async () => {
    const runtime = new FakeRuntime(handsOffWhenSent)
    const runner = makeRunner(runtime)
    const [a, b, c, d] = [await newTicket('A'), await newTicket('B'), await newTicket('C'), await newTicket('D')]
    for (const t of [a, b, c]) await runner.start(t.id)
    await runner.start(d.id)

    expect(runtime.specs).toHaveLength(3)
    for (const t of [a, b, c]) expect(await stateOf(runner, t)).toMatchObject({ column: 'in_progress', agentStatus: 'working' })
    expect(await stateOf(runner, d)).toMatchObject({
      column: 'in_progress',
      phase: 'implementing',
      agentStatus: 'queued',
      queuePosition: 1,
      canContinue: false
    })
    expect(await repos.runs.latest(d.id)).toMatchObject({ endReason: null })
  })

  it('starts a queued agent when another reaches Review, with the message it would have started with', async () => {
    await repos.settings.setMaxAgents(1)
    const runtime = new FakeRuntime(handsOffWhenSent)
    const runner = makeRunner(runtime)
    const [a, b] = [await newTicket('A'), await newTicket('B')]
    await runner.start(a.id)
    await runner.start(b.id)
    expect(runtime.specs).toHaveLength(1)
    expect(await stateOf(runner, b)).toMatchObject({ agentStatus: 'queued', queuePosition: 1 })

    await finish(runner, a)
    await waitForStatus(runner, b, 'working')

    expect(runtime.specs).toHaveLength(2)
    expect(runtime.specs[1]!.prompt).toBe(firstMessage(await repos.tickets.get(b.id)))
    expect(await repos.runs.queued()).toEqual([])
    expect(await stateOf(runner, b)).not.toHaveProperty('queuePosition')
  })

  it('starts queued agents first in, first out as slots free up, and renumbers the places', async () => {
    await repos.settings.setMaxAgents(1)
    const runtime = new FakeRuntime(handsOffWhenSent)
    const runner = makeRunner(runtime)
    const [a, b, c, d] = [await newTicket('A'), await newTicket('B'), await newTicket('C'), await newTicket('D')]
    for (const t of [a, b, c, d]) await runner.start(t.id)
    expect((await stateOf(runner, b)).queuePosition).toBe(1)
    expect((await stateOf(runner, c)).queuePosition).toBe(2)
    expect((await stateOf(runner, d)).queuePosition).toBe(3)

    await finish(runner, a)
    await waitForStatus(runner, b, 'working')
    expect((await stateOf(runner, c)).queuePosition).toBe(1)
    expect((await stateOf(runner, d)).queuePosition).toBe(2)

    await finish(runner, b)
    await waitForStatus(runner, c, 'working')
    expect((await stateOf(runner, d)).queuePosition).toBe(1)

    await finish(runner, c)
    await waitForStatus(runner, d, 'working')
    expect(runtime.specs.map((s) => s.cwd.split(path.sep).at(-1))).toEqual(['1-a', '2-b', '3-c', '4-d'])
  })

  it('shows the position in the lineup strip too', async () => {
    await repos.settings.setMaxAgents(1)
    const runner = makeRunner(new FakeRuntime(handsOffWhenSent))
    const [a, b] = [await newTicket('A'), await newTicket('B')]
    await runner.start(a.id)
    await runner.start(b.id)
    const { lineup } = await runner.boardView(b.id, async () => [])
    expect(lineup).toEqual([expect.objectContaining({ name: 'Implementer', status: 'queued', active: true, queuePosition: 1 })])
  })

  it('shows a queued agent to the stuck detector as a run with no process, queued', async () => {
    await repos.settings.setMaxAgents(1)
    const runner = makeRunner(new FakeRuntime(handsOffWhenSent))
    const [a, b] = [await newTicket('A'), await newTicket('B')]
    await runner.start(a.id)
    await runner.start(b.id)
    expect(await runner.observeRun(b.id)).toMatchObject({ live: null, state: { agentStatus: 'queued' } })
  })
})

describe('the queued marker', () => {
  const queuedEvents = async (t: Ticket) => (await repos.runs.events((await repos.runs.latest(t.id))!.id)).filter((e) => e.event.kind === 'queued')

  it('is recorded once when a run joins the queue, not again for a message while it waits, and is not recorded for a run that starts at once', async () => {
    await repos.settings.setMaxAgents(1)
    const runtime = new FakeRuntime(handsOffWhenSent)
    const runner = makeRunner(runtime)
    const [a, b] = [await newTicket('A'), await newTicket('B')]
    await runner.start(a.id)
    await runner.start(b.id)
    expect(await queuedEvents(a)).toHaveLength(0)
    expect(await queuedEvents(b)).toHaveLength(1)

    await runner.send(b.id, 'Use the new API')
    expect(await queuedEvents(b)).toHaveLength(1)

    await finish(runner, a)
    await waitForStatus(runner, b, 'working')
    const events = (await repos.runs.events((await repos.runs.latest(b.id))!.id)).map((e) => e.event.kind)
    expect(events.indexOf('queued')).toBeLessThan(events.indexOf('session'))
    // The marker must not make the first launch look like a resume.
    expect(runtime.specs[1]!.resumeSessionId).toBeUndefined()
  })
})

describe('what uses a slot', () => {
  it('an agent waiting on a pending decision still uses its slot', async () => {
    await repos.settings.setMaxAgents(1)
    const runtime = new FakeRuntime([{ callTool: 'askUser', args: { question: 'Which API?', options: ['Old', 'New'] } }, { waitForSend: true }])
    const runner = makeRunner(runtime)
    const [a, b] = [await newTicket('A'), await newTicket('B')]
    await runner.start(a.id)
    await waitForStatus(runner, a, 'waiting_on_you')
    await runner.start(b.id)

    expect(await stateOf(runner, b)).toMatchObject({ agentStatus: 'queued' })
    expect(runtime.specs).toHaveLength(1)
  })

  it('an agent whose only open decision is deferred gives its slot up', async () => {
    await repos.settings.setMaxAgents(1)
    const runtime = new FakeRuntime((spec) =>
      spec.cwd.endsWith('1-a')
        ? [{ callTool: 'askUser', args: { question: 'Which API?', options: ['Old', 'New'] } }, { waitForSend: true }]
        : [{ waitForSend: true }]
    )
    const runner = makeRunner(runtime)
    const [a, b] = [await newTicket('A'), await newTicket('B')]
    await runner.start(a.id)
    await waitForStatus(runner, a, 'waiting_on_you')
    await runner.start(b.id)
    expect(await stateOf(runner, b)).toMatchObject({ agentStatus: 'queued' })

    const [decision] = await repos.decisions.pending(a.id)
    await repos.decisions.defer(decision!.id, '2027-01-01T00:00:00.000Z')
    runner.kickQueue()

    await waitForStatus(runner, b, 'working')
    expect(runtime.specs).toHaveLength(2)
  })

  it('a user-paused agent gives its slot up, and its Resume waits for a free one', async () => {
    await repos.settings.setMaxAgents(1)
    const runtime = new FakeRuntime(handsOffWhenSent)
    const runner = makeRunner(runtime)
    const [a, b] = [await newTicket('A'), await newTicket('B')]
    await runner.start(a.id)
    await runner.start(b.id)
    expect(await stateOf(runner, b)).toMatchObject({ agentStatus: 'queued' })

    await runner.pause(a.id)
    await waitForStatus(runner, b, 'working')
    expect(await stateOf(runner, a)).toMatchObject({ agentStatus: 'paused', pausedByUser: true })

    // B holds the only slot now: A's Resume queues behind it instead of starting.
    await runner.resumePaused(a.id)
    expect(await stateOf(runner, a)).toMatchObject({ agentStatus: 'queued', queuePosition: 1 })
    expect(runtime.specs).toHaveLength(2)

    await finish(runner, b)
    await waitForStatus(runner, a, 'working')
    expect(runtime.specs[2]!.resumeSessionId).toBe(`session-${runtime.specs[0]!.cwd}-Implementer`)
  })

  it('an agent paused by a usage limit gives its slot up, but nothing else starts while the limit holds', async () => {
    await repos.settings.setMaxAgents(1)
    const usage = testUsage(repos)
    const runtime = new FakeRuntime((spec) =>
      spec.cwd.endsWith('1-a')
        ? [{ emit: { kind: 'rate_limit', status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, windows: {} } },
            { emit: { kind: 'turn_end', ok: false, error: 'usage limit reached' } }]
        : [{ waitForSend: true }]
    )
    const runner = makeRunner(runtime, { usage })
    const [a, b] = [await newTicket('A'), await newTicket('B')]
    await runner.start(a.id)
    await vi.waitFor(async () => expect(await stateOf(runner, a)).toMatchObject({ agentStatus: 'paused', pausedByLimit: true }))
    await runner.start(b.id)

    expect(await stateOf(runner, b)).toMatchObject({ agentStatus: 'queued' })
    expect(runtime.specs).toHaveLength(1)
  })
})

describe('every start path goes through the queue', () => {
  it('Continue on a paused agent queues when every slot is in use', async () => {
    await repos.settings.setMaxAgents(1)
    // A run that was paused by a restart: open, with a session, and no process.
    const before = makeRunner(new FakeRuntime([{ emit: { kind: 'session', sessionId: 's-1' } }, { emit: { kind: 'turn_end', ok: true } }, { exit: 0 }]))
    const a = await newTicket('A')
    await before.start(a.id)
    await vi.waitFor(async () => expect((await repos.runs.events((await repos.runs.latest(a.id))!.id)).some((e) => e.event.kind === 'process_exit')).toBe(true))

    const runtime = new FakeRuntime(handsOffWhenSent)
    const runner = makeRunner(runtime)
    const b = await newTicket('B')
    await runner.start(b.id)
    await runner.continue(a.id)

    expect(await stateOf(runner, a)).toMatchObject({ agentStatus: 'queued', queuePosition: 1, canContinue: false })
    expect(runtime.specs).toHaveLength(1)

    await finish(runner, b)
    await waitForStatus(runner, a, 'working')
    expect(runtime.specs[1]!.resumeSessionId).toBe('s-1')
  })

  it('a message to a queued agent is added to what it starts with and keeps its place', async () => {
    await repos.settings.setMaxAgents(1)
    const runtime = new FakeRuntime(handsOffWhenSent)
    const runner = makeRunner(runtime)
    const [a, b, c] = [await newTicket('A'), await newTicket('B'), await newTicket('C')]
    for (const t of [a, b, c]) await runner.start(t.id)

    await runner.send(b.id, 'Use the new API')
    expect((await stateOf(runner, b)).queuePosition).toBe(1)
    expect((await stateOf(runner, c)).queuePosition).toBe(2)

    await finish(runner, a)
    await waitForStatus(runner, b, 'working')
    expect(runtime.specs[1]!.prompt).toBe(`${firstMessage(await repos.tickets.get(b.id))}\n\nUse the new API`)
  })

  it('a replacement for an agent that held no slot queues', async () => {
    await repos.settings.setMaxAgents(1)
    const before = makeRunner(new FakeRuntime([{ emit: { kind: 'session', sessionId: 's-1' } }, { emit: { kind: 'turn_end', ok: true } }, { exit: 0 }]))
    const a = await newTicket('A')
    await before.start(a.id)
    await vi.waitFor(async () => expect((await repos.runs.events((await repos.runs.latest(a.id))!.id)).some((e) => e.event.kind === 'process_exit')).toBe(true))

    const runtime = new FakeRuntime(handsOffWhenSent)
    const runner = makeRunner(runtime)
    const b = await newTicket('B')
    await runner.start(b.id)
    const run = (await repos.runs.latest(a.id))!
    await runner.replace(a.id, { agentRunId: run.id }, { model: 'sonnet', effort: 'medium', extraInstructions: null })

    expect(await stateOf(runner, a)).toMatchObject({ agentStatus: 'queued', queuePosition: 1 })
    expect(runtime.specs).toHaveLength(1)
    await finish(runner, b)
    await waitForStatus(runner, a, 'working')
    expect(runtime.specs[1]!.prompt).toContain('was replaced')
  })

  it('a replacement for a working agent keeps its slot, ahead of the queue', async () => {
    await repos.settings.setMaxAgents(1)
    const runtime = new FakeRuntime(handsOffWhenSent)
    const runner = makeRunner(runtime)
    const [a, b] = [await newTicket('A'), await newTicket('B')]
    await runner.start(a.id)
    await runner.start(b.id)
    const run = (await repos.runs.latest(a.id))!
    await runner.replace(a.id, { agentRunId: run.id }, { model: 'sonnet', effort: 'medium', extraInstructions: null })

    await waitForStatus(runner, a, 'working')
    expect(runtime.specs).toHaveLength(2)
    expect(await stateOf(runner, b)).toMatchObject({ agentStatus: 'queued', queuePosition: 1 })
  })

  it('unattended mode keeps starting one ticket at a time, and its start queues like any other', async () => {
    await repos.settings.setMaxAgents(1)
    const runtime = new FakeRuntime(handsOffWhenSent)
    const runner = makeRunner(runtime, { unattended: true })
    const [a, b] = [await newTicket('A'), await newTicket('B')]
    await runner.start(a.id)
    await runner.start(b.id)
    expect(await stateOf(runner, b)).toMatchObject({ column: 'in_progress', agentStatus: 'queued' })
  })
})

describe('handoffs, hand-backs and Stop', () => {
  async function threeRoles(): Promise<void> {
    const [planner, implementer, reviewer] = defaultLineup()
    await repos.lineups.save(workspaceId, [planner!, implementer!, reviewer!])
  }

  it('the next role takes the ending role’s slot instead of joining the back of the queue', async () => {
    await repos.settings.setMaxAgents(1)
    await threeRoles()
    const runtime = new FakeRuntime(handsOffWhenSent)
    const runner = makeRunner(runtime)
    const [a, b] = [await newTicket('A'), await newTicket('B')]
    await runner.start(a.id)
    await runner.start(b.id)
    expect(await stateOf(runner, b)).toMatchObject({ agentStatus: 'queued' })

    // The Planner hands off to the Implementer, which starts at once; B is still waiting.
    await runner.send(a.id, 'go')
    await vi.waitFor(() => expect(runtime.specs.map((s) => /## Your role: (.+)/.exec(s.appendSystemPrompt)![1])).toEqual(['Planner', 'Implementer']))
    await waitForStatus(runner, a, 'working')
    expect(await stateOf(runner, b)).toMatchObject({ agentStatus: 'queued', queuePosition: 1 })

    await runner.send(a.id, 'go')
    await vi.waitFor(() => expect(runtime.specs).toHaveLength(3))
    expect(await stateOf(runner, b)).toMatchObject({ agentStatus: 'queued' })

    // The Reviewer is last: when it hands off, B finally gets the slot.
    await runner.send(a.id, 'go')
    await waitForStatus(runner, a, 'handed_off')
    await waitForStatus(runner, b, 'working')
    expect(runtime.specs).toHaveLength(4)
  })

  it('a hand-back passes the slot to the earlier role', async () => {
    await repos.settings.setMaxAgents(1)
    await threeRoles()
    const runtime = new FakeRuntime((spec) => {
      const role = /## Your role: (.+)/.exec(spec.appendSystemPrompt)![1]!
      if (role === 'Planner' && spec.resumeSessionId === undefined) {
        return [{ emit: { kind: 'session', sessionId: 'planner-session' } }, { waitForSend: true }, { callTool: 'handoff', args: { summary: 'plan', notesForNext: '' } }, { emit: { kind: 'turn_end', ok: true } }]
      }
      if (role === 'Implementer') {
        return [{ callTool: 'reportProblem', args: { details: 'The plan is wrong' } }, { emit: { kind: 'turn_end', ok: true } }]
      }
      return [{ waitForSend: true }]
    })
    const runner = makeRunner(runtime)
    const [a, b] = [await newTicket('A'), await newTicket('B')]
    await runner.start(a.id)
    await runner.start(b.id)
    await runner.send(a.id, 'go')

    // The Implementer hands the problem back to the Planner, which resumes in the same slot; B stays queued.
    await vi.waitFor(async () => {
      const runs = await repos.runs.listForTicket(a.id)
      expect(runs.map((r) => r.role)).toEqual(['Planner', 'Implementer', 'Planner'])
    })
    await vi.waitFor(() => expect(runtime.specs.at(-1)!.resumeSessionId).toBe('planner-session'))
    await waitForStatus(runner, a, 'working')
    expect(await stateOf(runner, b)).toMatchObject({ agentStatus: 'queued', queuePosition: 1 })
  })

  it('Stop on a queued ticket takes it out of the queue and puts it back in Ready; nothing starts for it later', async () => {
    await repos.settings.setMaxAgents(1)
    const runtime = new FakeRuntime(handsOffWhenSent)
    const runner = makeRunner(runtime)
    const [a, b, c] = [await newTicket('A'), await newTicket('B'), await newTicket('C')]
    for (const t of [a, b, c]) await runner.start(t.id)

    await runner.stop(b.id)

    expect(await stateOf(runner, b)).toMatchObject({ column: 'ready', agentStatus: null })
    expect((await repos.runs.queued()).map((r) => r.ticketId)).toEqual([c.id])
    expect((await stateOf(runner, c)).queuePosition).toBe(1)
    await finish(runner, a)
    await waitForStatus(runner, c, 'working')
    expect(runtime.specs).toHaveLength(2)
    expect(runtime.specs.some((s) => s.cwd.endsWith('2-b') && s.prompt.includes('B'))).toBe(false)
  })
})

describe('the cap changing, and restarts', () => {
  it('lowering the cap stops no running agent, and new starts wait until the count is under the new cap', async () => {
    await repos.settings.setMaxAgents(2)
    const runtime = new FakeRuntime(handsOffWhenSent)
    const runner = makeRunner(runtime)
    const [a, b, c, d] = [await newTicket('A'), await newTicket('B'), await newTicket('C'), await newTicket('D')]
    await runner.start(a.id)
    await runner.start(b.id)
    await repos.settings.setMaxAgents(1)
    runner.kickQueue()
    await runner.start(c.id)

    expect(await stateOf(runner, a)).toMatchObject({ agentStatus: 'working' })
    expect(await stateOf(runner, b)).toMatchObject({ agentStatus: 'working' })
    expect(await stateOf(runner, c)).toMatchObject({ agentStatus: 'queued' })

    // One of two running is done; one is still running and the cap is one, so C still waits.
    await finish(runner, a)
    await runner.queueSettled()
    expect(await stateOf(runner, c)).toMatchObject({ agentStatus: 'queued' })
    await runner.start(d.id)
    expect(await stateOf(runner, d)).toMatchObject({ agentStatus: 'queued', queuePosition: 2 })

    await finish(runner, b)
    await waitForStatus(runner, c, 'working')
    expect(await stateOf(runner, d)).toMatchObject({ agentStatus: 'queued', queuePosition: 1 })
  })

  it('raising the cap starts queued agents at once, first in first out', async () => {
    await repos.settings.setMaxAgents(1)
    const runtime = new FakeRuntime(handsOffWhenSent)
    const runner = makeRunner(runtime)
    const [a, b, c] = [await newTicket('A'), await newTicket('B'), await newTicket('C')]
    for (const t of [a, b, c]) await runner.start(t.id)

    await repos.settings.setMaxAgents(2)
    runner.kickQueue()
    await waitForStatus(runner, b, 'working')
    await runner.queueSettled()
    expect(await stateOf(runner, c)).toMatchObject({ agentStatus: 'queued', queuePosition: 1 })
  })

  it('the queue and its order survive a restart: a new runner starts the queued agents first in, first out', async () => {
    await repos.settings.setMaxAgents(1)
    const first = makeRunner(new FakeRuntime(handsOffWhenSent))
    const [a, b, c] = [await newTicket('A'), await newTicket('B'), await newTicket('C')]
    for (const t of [a, b, c]) await first.start(t.id)
    expect((await repos.runs.queued()).map((r) => r.ticketId)).toEqual([b.id, c.id])
    await first.shutdown()

    // A new session over the same database: the agent that was running is paused now, and the queue is still there.
    const runtime = new FakeRuntime(handsOffWhenSent)
    const second = makeRunner(runtime)
    await second.markAllNotAlive()
    expect(await stateOf(second, a)).toMatchObject({ agentStatus: 'paused', canContinue: true })
    expect(await stateOf(second, b)).toMatchObject({ agentStatus: 'queued', queuePosition: 1 })
    expect(await stateOf(second, c)).toMatchObject({ agentStatus: 'queued', queuePosition: 2 })

    second.kickQueue()
    await waitForStatus(second, b, 'working')
    await second.queueSettled()
    expect(runtime.specs).toHaveLength(1)
    expect(runtime.specs[0]!.prompt).toBe(firstMessage(await repos.tickets.get(b.id)))
    expect(await stateOf(second, c)).toMatchObject({ agentStatus: 'queued', queuePosition: 1 })
  })

  it('nothing starts while the app is shutting down, and the queue is left as it was', async () => {
    await repos.settings.setMaxAgents(1)
    const runtime = new FakeRuntime(handsOffWhenSent)
    const runner = makeRunner(runtime)
    const [a, b] = [await newTicket('A'), await newTicket('B')]
    await runner.start(a.id)
    await runner.start(b.id)
    await runner.shutdown()
    runner.kickQueue()
    await runner.queueSettled()

    expect(runtime.specs).toHaveLength(1)
    expect((await repos.runs.queued()).map((r) => r.ticketId)).toEqual([b.id])
  })
})
