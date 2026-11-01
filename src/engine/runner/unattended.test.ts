import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent } from '../../shared/api'
import type { Column, Ticket, TicketState, UnattendedState } from '../../shared/domain'
import type { ThreadEvent } from '../../shared/events'
import { runGit } from '../git/git'
import { resolveHome, type HomePaths } from '../home'
import { createEngine, type Engine } from '../index'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import { defaultLineup } from '../store/lineups'
import type { ExecFn } from '../runtime/resolveClaude'
import type { RunSpec } from '../runtime/types'
import { UnattendedMode, type UnattendedDeps } from './unattended'
import type { UsageLimit } from './usageLimit'

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]

async function git(args: string[], cwd: string): Promise<void> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-unattended-'))
  repoPath = path.join(tmp, 'repo')
  await fs.mkdir(repoPath)
  await git(['init', '-b', 'main'], repoPath)
  await fs.writeFile(path.join(repoPath, 'README.md'), 'hello\n')
  await git(['add', '.'], repoPath)
  await git(['commit', '-m', 'initial'], repoPath)
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  engines = []
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

// --- scripts, by what the ticket's agent does ---

const handoff: FakeStep[] = [
  { emit: { kind: 'session', sessionId: 's' } },
  { callTool: 'handoff', args: { summary: 'Done', notesForNext: '' } },
  { emit: { kind: 'turn_end', ok: true } },
  { waitForSend: true }
]
const ask: FakeStep[] = [
  { emit: { kind: 'session', sessionId: 's' } },
  { callTool: 'askUser', args: { question: 'Which API?', options: ['Old', 'New'] } },
  { emit: { kind: 'turn_end', ok: true } },
  { waitForSend: true },
  ...handoff.slice(1)
]
const failing = (error: string): FakeStep[] => [
  { emit: { kind: 'session', sessionId: 's' } },
  { emit: { kind: 'turn_end', ok: false, error } },
  { emit: { kind: 'turn_end', ok: false, error } },
  { waitForSend: true }
]
const permission = (command: string, then: FakeStep[]): FakeStep[] => [
  { emit: { kind: 'session', sessionId: 's' } },
  { requestPermission: { toolName: 'Bash', input: { command }, toolUseId: 'tool-1' } },
  ...then
]
/** Never settles: the agent keeps working. */
const working: FakeStep[] = [{ emit: { kind: 'session', sessionId: 's' } }, { waitForSend: true }]

/** Plays each ticket's script by the number in its worktree folder; a resumed run plays `resumed`. */
function runtimeFor(scripts: Record<number, FakeStep[]>, resumed: FakeStep[] = handoff): FakeRuntime {
  return new FakeRuntime((spec: RunSpec) => {
    if (spec.resumeSessionId !== undefined) return resumed
    const n = Number(/^(\d+)-/.exec(path.basename(spec.cwd))?.[1])
    return scripts[n] ?? handoff
  })
}

interface Harness {
  engine: Engine
  runtime: FakeRuntime
  events: EngineEvent[]
  awake: { starts: number; stops: number; held: () => boolean }
  tickets: Ticket[]
}

async function harness(runtime: FakeRuntime, columns: ('ready' | 'backlog')[]): Promise<Harness> {
  const awake = { starts: 0, stops: 0, held: () => awake.starts > awake.stops }
  const engine = await createEngine({
    paths,
    migrationsDir,
    runtime,
    git: runGit,
    exec,
    keepAwake: { start: () => void awake.starts++, stop: () => void awake.stops++ }
  })
  engines.push(engine)
  const events: EngineEvent[] = []
  engine.on((e) => events.push(e))
  await engine.invoke('workspace.open', repoPath)
  // One role per ticket, so a single handoff settles it; the lineup test below sets its own.
  const implementer = (await engine.invoke('lineup.get')).find((r) => r.name === 'Implementer')!
  await engine.invoke('lineup.save', [{ ...implementer, handBackTo: null }])
  const tickets: Ticket[] = []
  for (const [i, column] of columns.entries()) {
    tickets.push(
      await engine.invoke('ticket.create', { title: `Ticket ${i + 1}`, intent: 'x', spec: '', criteria: [], labels: [], column })
    )
  }
  return { engine, runtime, events, awake, tickets }
}

async function columnOf(h: Harness, n: number): Promise<Column> {
  const t = (await h.engine.invoke('board.get')).tickets.find((x) => x.number === n)
  return t!.state.column
}

async function waitForColumn(h: Harness, n: number, column: Column): Promise<void> {
  await vi.waitFor(async () => expect(await columnOf(h, n)).toBe(column), { timeout: 10_000 })
}

async function waitForState(h: Harness, match: Partial<UnattendedState> | ((s: UnattendedState) => boolean)): Promise<void> {
  await vi.waitFor(
    async () => {
      const s = await h.engine.invoke('unattended.get')
      if (typeof match === 'function') expect(match(s)).toBe(true)
      else expect(s).toMatchObject(match)
    },
    { timeout: 10_000 }
  )
}

async function threadOf(h: Harness, n: number): Promise<ThreadEvent[]> {
  const t = h.tickets.find((x) => x.number === n)!
  return (await h.engine.invoke('thread.get', t.id)).events.map((e) => e.event)
}

/** The ticket numbers the runtime started (not resumed), in order. */
function started(h: Harness): number[] {
  return h.runtime.specs.filter((s) => s.resumeSessionId === undefined).map((s) => Number(/^(\d+)-/.exec(path.basename(s.cwd))?.[1]))
}

describe('unattended mode', () => {
  // Six agents in real worktrees: slow on a busy machine.
  it("runs each ticket through its whole lineup, and starts no other ticket between one ticket's roles", { timeout: 30_000 }, async () => {
    const h = await harness(runtimeFor({}), ['ready', 'ready'])
    await h.engine.invoke('lineup.save', defaultLineup())

    await h.engine.invoke('unattended.set', true)
    await waitForState(h, { on: true, status: { kind: 'idle' } })

    // Planner, Implementer and Reviewer of ticket 1, then the same of ticket 2.
    expect(started(h)).toEqual([1, 1, 1, 2, 2, 2])
    expect(h.runtime.specs.map((s) => /## Your role: (\w+)/.exec(s.appendSystemPrompt)?.[1])).toEqual([
      'Planner',
      'Implementer',
      'Reviewer',
      'Planner',
      'Implementer',
      'Reviewer'
    ])
    expect(await columnOf(h, 1)).toBe('review')
    expect(await columnOf(h, 2)).toBe('review')
    const statuses = h.events.flatMap((e) => (e.type === 'unattended.changed' ? [e.state.status] : []))
    expect(statuses).not.toContainEqual(expect.objectContaining({ kind: 'stopped' }))
  })

  it('is off at launch, works through Ready lowest number first, then stays on and waits when Ready is empty', async () => {
    const h = await harness(runtimeFor({}), ['ready', 'backlog', 'ready'])
    expect(await h.engine.invoke('unattended.get')).toEqual({ on: false, status: { kind: 'off' } })

    await h.engine.invoke('unattended.set', true)
    await waitForState(h, { on: true, status: { kind: 'idle' } })

    expect(started(h)).toEqual([1, 3])
    expect(await columnOf(h, 1)).toBe('review')
    expect(await columnOf(h, 3)).toBe('review')
    // Backlog is never started.
    expect(await columnOf(h, 2)).toBe('backlog')
    const statuses = h.events.flatMap((e) => (e.type === 'unattended.changed' ? [e.state.status] : []))
    expect(statuses).toContainEqual({ kind: 'working', ticketNumber: 1 })
    expect(statuses).toContainEqual({ kind: 'working', ticketNumber: 3 })
    // The machine was kept awake while tickets worked, and is let go while the mode waits.
    expect(h.awake).toMatchObject({ starts: 1, stops: 1 })

    // A ticket moved to Ready is started at once.
    await h.engine.invoke('ticket.move', h.tickets[1]!.id, 'ready')
    await waitForColumn(h, 2, 'review')
    await waitForState(h, { on: true, status: { kind: 'idle' } })
    expect(started(h)).toEqual([1, 3, 2])
    expect(h.awake).toMatchObject({ starts: 2, stops: 2 })
  })

  it('switched on with Ready empty, stays on and idle without holding the machine awake', async () => {
    const h = await harness(runtimeFor({}), ['backlog'])
    await h.engine.invoke('unattended.set', true)
    await waitForState(h, { on: true, status: { kind: 'idle' } })
    await new Promise((r) => setTimeout(r, 200))
    expect(h.awake).toMatchObject({ starts: 0, stops: 0 })
    expect(started(h)).toEqual([])
    // Switching off from idle has nothing to release.
    await h.engine.invoke('unattended.set', false)
    expect(h.awake).toMatchObject({ starts: 0, stops: 0 })
  })

  it('switched on while a hand-started ticket works, starts nothing until it settles, and allows its requests meanwhile', async () => {
    const handStarted: FakeStep[] = [
      { emit: { kind: 'session', sessionId: 's' } },
      { waitForSend: true },
      { requestPermission: { toolName: 'Bash', input: { command: 'npm install zod' }, toolUseId: 'tool-1' } },
      ...handoff.slice(1)
    ]
    const h = await harness(runtimeFor({ 1: handStarted, 2: working }), ['ready', 'ready'])
    await h.engine.invoke('agent.start', h.tickets[0]!.id)
    await waitForColumn(h, 1, 'in_progress')

    await h.engine.invoke('unattended.set', true)
    await waitForState(h, { on: true, status: { kind: 'other_working', ticketNumber: 1 } })
    await new Promise((r) => setTimeout(r, 200))
    expect(started(h)).toEqual([1])
    expect(await columnOf(h, 2)).toBe('ready')
    expect(h.awake.held()).toBe(true)

    // Ticket 1 asks for a permission: the mode allows it, then the ticket reaches Review and the mode starts ticket 2.
    await h.engine.invoke('agent.send', h.tickets[0]!.id, 'go on')
    await waitForColumn(h, 1, 'review')
    expect((await h.engine.invoke('thread.get', h.tickets[0]!.id)).decisions).toEqual([])
    expect(await threadOf(h, 1)).toContainEqual({
      kind: 'notice',
      text: 'Allowed by unattended mode: Implementer wants to run `npm install zod`'
    })
    await waitForColumn(h, 2, 'in_progress')
    expect(started(h)).toEqual([1, 2])
    expect(await h.engine.invoke('unattended.get')).toEqual({ on: true, status: { kind: 'working', ticketNumber: 2 } })
  })

  it('never starts a Ready ticket while any ticket is working, and Stop on a ticket it did not start leaves it on', async () => {
    // Ticket 1 asks; answered, it goes on working alongside ticket 2.
    const askThenWork: FakeStep[] = [...ask.slice(0, 4), { waitForSend: true }]
    const h = await harness(runtimeFor({ 1: askThenWork, 2: handoff }), ['ready', 'ready', 'backlog'])
    await h.engine.invoke('unattended.set', true)
    await waitForColumn(h, 1, 'needs_you')
    const { decisions } = await h.engine.invoke('thread.get', h.tickets[0]!.id)
    await h.engine.invoke('decision.answer', decisions[0]!.id, { kind: 'option', index: 1 })
    await waitForColumn(h, 2, 'review')
    await waitForColumn(h, 1, 'in_progress')
    await waitForState(h, { on: true, status: { kind: 'other_working', ticketNumber: 1 } })

    await h.engine.invoke('ticket.move', h.tickets[2]!.id, 'ready')
    await new Promise((r) => setTimeout(r, 200))
    expect(await columnOf(h, 3)).toBe('ready')
    expect(started(h)).toEqual([1, 2])

    // Stopping ticket 1, which the mode did not start, leaves the mode on and frees it to start ticket 3.
    // Ticket 1 is back in Ready, but the user stopped it: the mode does not start it again.
    await h.engine.invoke('agent.stop', h.tickets[0]!.id)
    await waitForColumn(h, 3, 'review')
    await waitForState(h, { on: true, status: { kind: 'idle' } })
    expect(await columnOf(h, 1)).toBe('ready')
    expect(started(h)).toEqual([1, 2, 3])

    // Moved to Ready by the user, it is started like any other.
    await h.engine.invoke('ticket.move', h.tickets[0]!.id, 'ready')
    await vi.waitFor(() => expect(started(h)).toEqual([1, 2, 3, 1]), { timeout: 10_000 })
  }, 20_000)

  it('starts one ticket at a time: the next waits until the first settles', async () => {
    const h = await harness(runtimeFor({ 1: working }), ['ready', 'ready'])
    await h.engine.invoke('unattended.set', true)
    await waitForState(h, { status: { kind: 'working', ticketNumber: 1 } })
    await waitForColumn(h, 1, 'in_progress')
    // Give the queue every chance to start another.
    await new Promise((r) => setTimeout(r, 300))
    expect(started(h)).toEqual([1])
    expect(await columnOf(h, 2)).toBe('ready')
    expect(h.awake.held()).toBe(true)
  })

  it('a question moves the ticket to Needs you and the queue moves on; answering it resumes it alongside', async () => {
    const h = await harness(runtimeFor({ 1: ask, 2: working }), ['ready', 'ready'])
    await h.engine.invoke('unattended.set', true)
    await waitForColumn(h, 1, 'needs_you')
    await waitForState(h, { on: true, status: { kind: 'working', ticketNumber: 2 } })
    await waitForColumn(h, 2, 'in_progress')

    const { decisions } = await h.engine.invoke('thread.get', h.tickets[0]!.id)
    await h.engine.invoke('decision.answer', decisions[0]!.id, { kind: 'option', index: 1 })
    // Ticket 1 goes on at once, while the queue's ticket 2 is still working.
    await waitForColumn(h, 1, 'review')
    expect(await columnOf(h, 2)).toBe('in_progress')
    expect(await h.engine.invoke('unattended.get')).toMatchObject({ on: true, status: { kind: 'working', ticketNumber: 2 } })
  })

  it('a hard-stop card blocks the ticket in Needs you and the queue moves on', async () => {
    const h = await harness(runtimeFor({ 1: permission('git push origin main', handoff.slice(1)), 2: working }), ['ready', 'ready'])
    await h.engine.invoke('unattended.set', true)
    await waitForColumn(h, 1, 'needs_you')
    await waitForState(h, { status: { kind: 'working', ticketNumber: 2 } })
    const { decisions } = await h.engine.invoke('thread.get', h.tickets[0]!.id)
    expect(decisions[0]).toMatchObject({ kind: 'permission', status: 'pending' })
    expect(decisions[0]!.question).toBe('Implementer wants to run `git push origin main`')
  })

  it('allows a request the guard has no opinion on without a card, records it, and saves no rule', async () => {
    const h = await harness(runtimeFor({ 1: permission('npm install zod', handoff.slice(1)) }), ['ready'])
    await h.engine.invoke('unattended.set', true)
    await waitForColumn(h, 1, 'review')
    const { decisions } = await h.engine.invoke('thread.get', h.tickets[0]!.id)
    expect(decisions).toEqual([])
    expect(await threadOf(h, 1)).toContainEqual({
      kind: 'notice',
      text: 'Allowed by unattended mode: Implementer wants to run `npm install zod`'
    })
    expect(await h.engine.invoke('allowRules.list')).toEqual([])
  })

  it('allows an automatic guard reason without a card', async () => {
    const h = await harness(runtimeFor({ 1: permission('git reset --hard', handoff.slice(1)) }), ['ready'])
    await h.engine.invoke('unattended.set', true)
    await waitForColumn(h, 1, 'review')
    expect((await h.engine.invoke('thread.get', h.tickets[0]!.id)).decisions).toEqual([])
  })

  it('with the mode off, the same request still raises a card', async () => {
    const h = await harness(runtimeFor({ 1: permission('npm install zod', handoff.slice(1)) }), ['ready'])
    await h.engine.invoke('agent.start', h.tickets[0]!.id)
    await waitForColumn(h, 1, 'needs_you')
    const { decisions } = await h.engine.invoke('thread.get', h.tickets[0]!.id)
    expect(decisions[0]).toMatchObject({ kind: 'permission', status: 'pending' })
  })

  it('three failed tickets in a row stop the mode with the last error', async () => {
    const h = await harness(runtimeFor({ 1: failing('one'), 2: failing('two'), 3: failing('three'), 4: handoff }), [
      'ready',
      'ready',
      'ready',
      'ready'
    ])
    await h.engine.invoke('unattended.set', true)
    await waitForState(h, { on: false, status: { kind: 'stopped', reason: '3 tickets failed in a row: three' } })
    expect(started(h)).toEqual([1, 2, 3])
    expect(await columnOf(h, 4)).toBe('ready')
    expect(h.awake).toMatchObject({ starts: 1, stops: 1 })
  })

  it('a ticket reaching Review or Needs you resets the failure count', async () => {
    const h = await harness(
      runtimeFor({ 1: failing('one'), 2: failing('two'), 3: handoff, 4: failing('four'), 5: ask, 6: failing('six') }),
      ['ready', 'ready', 'ready', 'ready', 'ready', 'ready']
    )
    await h.engine.invoke('unattended.set', true)
    await waitForState(h, { on: true, status: { kind: 'idle' } })
    expect(started(h)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('pressing Stop on the queue’s ticket turns the mode off', async () => {
    const h = await harness(runtimeFor({ 1: working }), ['ready', 'ready'])
    await h.engine.invoke('unattended.set', true)
    await waitForColumn(h, 1, 'in_progress')
    await h.engine.invoke('agent.stop', h.tickets[0]!.id)
    expect(await h.engine.invoke('unattended.get')).toEqual({ on: false, status: { kind: 'off' } })
    await new Promise((r) => setTimeout(r, 200))
    expect(started(h)).toEqual([1])
    expect(h.awake).toMatchObject({ starts: 1, stops: 1 })
  })

  it('a usage limit pauses the ticket, waits for the reset, and continues the same ticket', async () => {
    const resetsAt = Math.ceil(Date.now() / 1000) + 1
    const limited: FakeStep[] = [
      { emit: { kind: 'session', sessionId: 's1' } },
      { emit: { kind: 'rate_limit', status: 'rejected', resetsAt, windows: {} } },
      { emit: { kind: 'turn_end', ok: false, error: "You've hit your limit · resets 3pm" } },
      { waitForSend: true }
    ]
    const h = await harness(runtimeFor({ 1: limited }), ['ready', 'ready'])
    await h.engine.invoke('unattended.set', true)

    await waitForState(h, {
      on: true,
      status: { kind: 'waiting', ticketNumber: 1, until: new Date(resetsAt * 1000).toISOString() }
    })
    // Paused, not failed, and the queue did not move on.
    expect(await columnOf(h, 1)).toBe('in_progress')
    expect(started(h)).toEqual([1])
    expect(await threadOf(h, 1)).toContainEqual({ kind: 'notice', text: expect.stringContaining('Paused by the usage limit') })

    // After the reset the same ticket is continued, and the queue goes on from there.
    await waitForState(h, { on: true, status: { kind: 'idle' } })
    expect(h.runtime.specs.filter((s) => s.resumeSessionId === 's1')).toHaveLength(1)
    expect(started(h)).toEqual([1, 2])
    expect(await columnOf(h, 1)).toBe('review')
  }, 30_000)

  it('cannot be switched on without a runtime or a workspace', async () => {
    const engine = await createEngine({ paths, migrationsDir, runtime: null, git: runGit, exec })
    engines.push(engine)
    await expect(engine.invoke('unattended.set', true)).rejects.toThrow(/not set up/)
    expect(await engine.invoke('unattended.get')).toMatchObject({ on: false })

    const fresh = await createEngine({
      paths: resolveHome({ MAINBUS_HOME: path.join(tmp, 'home2') }, 'dev', os.homedir()),
      migrationsDir,
      runtime: new FakeRuntime([]),
      git: runGit,
      exec
    })
    engines.push(fresh)
    await expect(fresh.invoke('unattended.set', true)).rejects.toThrow('Open a workspace first')
  })

  it('is not reachable through the agent intake', async () => {
    const h = await harness(runtimeFor({}), ['ready'])
    for (const method of ['unattended.set', 'unattended.get', 'agent.start']) {
      await expect(h.engine.intake(method as never, { on: true } as never)).rejects.toThrow(`Unknown method: ${method}`)
    }
    expect(await h.engine.invoke('unattended.get')).toMatchObject({ on: false })
  })

  it('switching it off releases the machine, and stops nothing that is running', async () => {
    const h = await harness(runtimeFor({ 1: working }), ['ready', 'ready'])
    await h.engine.invoke('unattended.set', true)
    await waitForColumn(h, 1, 'in_progress')
    await h.engine.invoke('unattended.set', false)
    expect(h.awake).toMatchObject({ starts: 1, stops: 1 })
    expect(await columnOf(h, 1)).toBe('in_progress')
    // Switching off twice is harmless.
    await h.engine.invoke('unattended.set', false)
    expect(h.awake.stops).toBe(1)
  })
})

// --- the controller on its own, with a stub runner, for timing ---

describe('UnattendedMode timing', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** One ticket, #7, Ready until started; the test sets `box.state` after that. */
  function stub(limit: () => UsageLimit | undefined) {
    const ticket = { id: 't1', number: 7 } as Ticket
    const box = { state: ready }
    const state = () => box.state
    const runner = {
      start: vi.fn(async () => {
        box.state = working
      }),
      continue: vi.fn(async () => {}),
      stateOf: vi.fn(async () => state()),
      usageLimit: vi.fn(() => limit()),
      isLaunching: vi.fn(() => false)
    }
    const emitted: UnattendedState[] = []
    const deps: UnattendedDeps = {
      runner,
      tickets: async () => [ticket],
      checkCanRun: async () => {},
      emit: (e) => {
        if (e.type === 'unattended.changed') emitted.push(e.state)
      },
      keepAwake: { start: () => {}, stop: () => {} },
      now: () => new Date()
    }
    return { mode: new UnattendedMode(deps), runner, emitted, box }
  }

  const ready: TicketState = { column: 'ready', phase: 'not_started', agentStatus: null, summary: null, canContinue: false }
  const working: TicketState = { column: 'in_progress', phase: 'implementing', agentStatus: 'working', summary: null, canContinue: false }
  const paused: TicketState = { column: 'in_progress', phase: 'implementing', agentStatus: 'paused', summary: null, canContinue: true }

  it('without a reset time, retries every 15 minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { mode, runner, box } = stub(() => ({ resetsAt: null }))
    await mode.set(true)
    await mode.settled()
    expect(runner.start).toHaveBeenCalledTimes(1)
    expect(mode.get()).toEqual({ on: true, status: { kind: 'working', ticketNumber: 7 } })

    box.state = paused
    mode.observe({ type: 'board.changed', workspaceId: 'w' })
    await mode.settled()
    const until = new Date(Date.now() + 15 * 60 * 1000).toISOString()
    expect(mode.get()).toEqual({ on: true, status: { kind: 'waiting', ticketNumber: 7, until } })

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 - 1)
    expect(runner.continue).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(runner.continue).toHaveBeenCalledWith('t1')
    mode.dispose()
  })

  it('a reset time already past retries in 15 minutes, not at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { mode, runner, box } = stub(() => ({ resetsAt: Date.now() - 1000 }))
    await mode.set(true)
    await mode.settled()
    box.state = paused
    mode.observe({ type: 'board.changed', workspaceId: 'w' })
    await mode.settled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runner.continue).not.toHaveBeenCalled()
    mode.dispose()
  })

  it('a paused ticket without a usage limit counts as failed and the queue moves on', async () => {
    const { mode, runner, box } = stub(() => undefined)
    await mode.set(true)
    await mode.settled()
    box.state = paused
    mode.observe({ type: 'board.changed', workspaceId: 'w' })
    await mode.settled()
    // Ticket 7 is no longer Ready, so the queue finds nothing else and waits.
    expect(mode.get()).toEqual({ on: true, status: { kind: 'idle' } })
    expect(runner.continue).not.toHaveBeenCalled()
  })
})
