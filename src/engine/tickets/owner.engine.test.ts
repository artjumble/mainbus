import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { EngineEvent } from '../../shared/api'
import { yoursText } from '../../shared/owner'
import { runGit } from '../git/git'
import { FakeClock } from '../holds/clock'
import { type HomePaths } from '../home'
import { createEngine, type Engine } from '../index'
import { makeRepo } from '../intake/testBoard'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import type { ExecFn } from '../runtime/resolveClaude'
import { eventually } from '../testWait'
import { testHome } from '../testFixtures'

// Each test starts an engine over a real repository: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

const START = new Date('2026-11-02T09:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const MINUTE = 60_000
const iso = (days: number): string => new Date(START.getTime() + days * DAY).toISOString()

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]
let clock: FakeClock

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-owner-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = await testHome(path.join(tmp, 'home'))
  engines = []
  clock = new FakeClock(START)
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const session = (id: string): FakeStep => ({ emit: { kind: 'session', sessionId: id } })
const turnEnd = (): FakeStep => ({ emit: { kind: 'turn_end', ok: true } })
const WORKING: FakeStep[] = [session('role-sess'), { waitForSend: true }]
const HANDING_OFF: FakeStep[] = [session('role-sess'), { callTool: 'handoff', args: { summary: 'Did it', notesForNext: 'n' } }, turnEnd()]
const WAITING_ORCHESTRATOR: FakeStep[] = [session('orch'), { waitForSend: true }]
const QUIET_ORCHESTRATOR: FakeStep[] = [session('orch'), turnEnd(), { waitForSend: true }]

async function makeEngine(role: FakeStep[] = WORKING, orchestrator: FakeStep[] = QUIET_ORCHESTRATOR) {
  const runtime = new FakeRuntime(role, { orchestrator })
  const events: EngineEvent[] = []
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec, clock })
  engine.on((e) => events.push(e))
  engines.push(engine)
  await engine.invoke('workspace.open', repoPath)
  return { engine, runtime, events }
}

const newTicket = (engine: Engine, title = 'Login', column: 'backlog' | 'ready' = 'ready', extra: object = {}) =>
  engine.invoke('ticket.create', { title, intent: `Do ${title}`, spec: '', criteria: [], labels: [], column, ...extra })
const ticketOf = async (engine: Engine, id: string) => (await engine.invoke('board.get')).tickets.find((t) => t.id === id)!
const humanTicket = async (engine: Engine, title = 'Mine', column: 'backlog' | 'ready' = 'ready', extra: object = {}) => {
  const t = await newTicket(engine, title, column, extra)
  await engine.invoke('ticket.setOwner', t.id, 'human')
  return t
}
const pendingStarts = async (engine: Engine) =>
  (await engine.invoke('orchestrator.get')).proposals.filter((p) => p.kind === 'start_lineup' && p.status === 'pending')
const wakes = async (engine: Engine) => (await engine.invoke('orchestrator.get')).events.filter((e) => e.event.kind === 'wake')

async function liveTools(engine: Engine, runtime: FakeRuntime) {
  await engine.invoke('orchestrator.send', 'Hello')
  await eventually(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
  return runtime.orchestratorSpecs[0]!.tools
}

describe('a human-owned ticket is never started', () => {
  test('Start refuses it, starts nothing, and keeps its hold', async () => {
    const { engine, runtime } = await makeEngine()
    const t = await humanTicket(engine)
    await engine.invoke('ticket.hold', t.id)
    await expect(engine.invoke('agent.start', t.id)).rejects.toThrow(yoursText(t.number))
    expect(runtime.specs).toEqual([])
    expect((await ticketOf(engine, t.id)).hold).not.toBeNull()
    expect((await ticketOf(engine, t.id)).state.column).toBe('ready')
  })

  test('dragging it into In progress is refused with the reason', async () => {
    const { engine } = await makeEngine()
    const t = await humanTicket(engine)
    await expect(engine.invoke('ticket.proposeStart', t.id)).rejects.toThrow(yoursText(t.number))
    expect(await pendingStarts(engine)).toEqual([])
  })

  test('propose_start refuses it; a start proposed before the conversion fails and starts nothing', async () => {
    const { engine, runtime } = await makeEngine(WORKING, WAITING_ORCHESTRATOR)
    const t = await newTicket(engine)
    const tools = await liveTools(engine, runtime)
    expect(await tools.proposeStart({ ticket: t.number })).toMatch(/^Proposed /)
    const [pending] = await pendingStarts(engine)
    await engine.invoke('ticket.setOwner', t.id, 'human')

    expect(await tools.proposeStart({ ticket: t.number })).toBe(
      `Invalid proposal: ticket: ${yoursText(t.number)}. Nothing was stored; fix it and propose again.`
    )
    const confirmed = await engine.invoke('proposal.confirm', pending!.id)
    expect(confirmed).toMatchObject({ status: 'failed', result: { error: expect.stringContaining('is yours') } })
    expect(runtime.specs).toEqual([])
  })

  test('start-when-ready proposes nothing for it, and the spent flag is not revived by handing it back', async () => {
    const { engine } = await makeEngine()
    const t = await newTicket(engine, 'Asked', 'backlog', { startWhenReady: true })
    await engine.invoke('ticket.setOwner', t.id, 'human')
    await engine.invoke('ticket.move', t.id, 'ready')
    expect(await pendingStarts(engine)).toHaveLength(0)

    await engine.invoke('ticket.setOwner', t.id, 'agent')
    await engine.invoke('ticket.move', t.id, 'backlog')
    await engine.invoke('ticket.move', t.id, 'ready')
    expect(await pendingStarts(engine)).toHaveLength(0)
  })

  test('Update from main refuses it, in the command and as a proposal', async () => {
    const { engine, runtime } = await makeEngine(WORKING, WAITING_ORCHESTRATOR)
    const t = await humanTicket(engine)
    await expect(engine.invoke('ticket.updateFromMain', t.id)).rejects.toThrow(yoursText(t.number))
    const tools = await liveTools(engine, runtime)
    expect(await tools.proposeUpdateFromMain({ ticket: t.number, reason: 'Main moved on' })).toContain(yoursText(t.number))
    expect(runtime.specs).toEqual([])
  })
})

describe('unattended mode and a human-owned ticket', () => {
  test('passes over a human ticket at the top of Ready and starts the next agent ticket', async () => {
    const { engine, runtime } = await makeEngine()
    const mine = await humanTicket(engine, 'Mine')
    const open = await newTicket(engine, 'Open')
    await engine.invoke('unattended.set', true)
    await eventually(async () => expect((await ticketOf(engine, open.id)).state.column).toBe('in_progress'))
    expect((await ticketOf(engine, mine.id)).state.column).toBe('ready')
    expect(runtime.specs).toHaveLength(1)
  })

  test('human tickets never count toward tickets at once', async () => {
    const { engine, runtime } = await makeEngine()
    await humanTicket(engine, 'Mine 1')
    await humanTicket(engine, 'Mine 2')
    const a = await newTicket(engine, 'A')
    const b = await newTicket(engine, 'B')
    await engine.invoke('unattended.set', true)
    await eventually(() => expect(runtime.specs).toHaveLength(1))
    await clock.advance(MINUTE)
    expect(runtime.specs).toHaveLength(1)
    const columns = [(await ticketOf(engine, a.id)).state.column, (await ticketOf(engine, b.id)).state.column].sort()
    expect(columns).toEqual(['in_progress', 'ready'])
  })

  test('with only human tickets it stays idle and starts nothing', async () => {
    const { engine, runtime } = await makeEngine()
    await humanTicket(engine)
    await engine.invoke('unattended.set', true)
    await eventually(async () => expect((await engine.invoke('unattended.get')).status).toEqual({ kind: 'idle' }))
    expect(runtime.specs).toEqual([])
  })
})

describe('wakes and a human-owned ticket', () => {
  test('a human ticket moved to Done is not reviewed', async () => {
    const { engine, runtime } = await makeEngine(HANDING_OFF)
    const t = await newTicket(engine)
    await engine.invoke('agent.start', t.id)
    await eventually(async () => expect((await ticketOf(engine, t.id)).state.column).toBe('review'))
    await engine.invoke('ticket.setOwner', t.id, 'human')
    expect(await engine.invoke('ticket.move', t.id, 'done')).toBe('moved')
    await clock.advance(10 * MINUTE)
    expect(runtime.orchestratorSpecs).toHaveLength(0)
    expect(await wakes(engine)).toEqual([])
  })

  test('a dated hold on it running out wakes nothing and is not listed as released', async () => {
    const { engine, runtime } = await makeEngine(WORKING, [session('orch'), turnEnd(), { waitForSend: true }, turnEnd()])
    const t = await humanTicket(engine)
    await engine.invoke('orchestrator.send', 'Hello')
    await eventually(async () => expect((await engine.invoke('orchestrator.get')).status).toBe('idle'))
    await clock.advance(1000)
    await engine.invoke('ticket.hold', t.id, { until: iso(1) })
    await clock.advance(DAY)
    expect(await wakes(engine)).toEqual([])
    await engine.invoke('orchestrator.send', 'Anything new?')
    await eventually(() => expect(runtime.sent).toHaveLength(1))
    expect(runtime.sent[0]).not.toContain('held tickets were released')
  })

  test('a human dependent still gets the unblocked note, and nothing starts', async () => {
    const { engine, runtime } = await makeEngine()
    const blocker = await newTicket(engine, 'First')
    const dependent = await humanTicket(engine, 'Second', 'ready', { blockedBy: [blocker.id] })
    await engine.invoke('ticket.move', blocker.id, 'done')
    expect((await ticketOf(engine, dependent.id)).dependencyNotes).toEqual([expect.objectContaining({ kind: 'unblocked' })])
    expect(runtime.specs).toEqual([])
    expect(await pendingStarts(engine)).toEqual([])
  })
})

describe('ticket.setOwner', () => {
  test('is refused while a run is open or paused, and in Done', async () => {
    const { engine } = await makeEngine()
    const t = await newTicket(engine)
    await engine.invoke('agent.start', t.id)
    await eventually(async () => expect((await ticketOf(engine, t.id)).state.agentStatus).toBe('working'))
    await expect(engine.invoke('ticket.setOwner', t.id, 'human')).rejects.toThrow('has a run open')
    await engine.invoke('agent.pause', t.id)
    await expect(engine.invoke('ticket.setOwner', t.id, 'human')).rejects.toThrow('has a run open')
    expect((await ticketOf(engine, t.id)).owner).toBe('agent')

    const done = await newTicket(engine, 'Finished')
    await engine.invoke('ticket.move', done.id, 'done')
    await expect(engine.invoke('ticket.setOwner', done.id, 'human')).rejects.toThrow('is Done')
  })

  test('round trip keeps run settings, records Activity in order, and emits board.changed', async () => {
    const { engine, events } = await makeEngine()
    const t = await newTicket(engine)
    const lineup = (await ticketOf(engine, t.id)).lineup
    await engine.invoke('ticket.setRunSettings', t.id, { excludedRoleIds: [lineup.at(-1)!.id], roles: {}, extraInstructions: 'Be careful' })
    const before = (await ticketOf(engine, t.id)).runSettings
    expect(before).not.toBeNull()

    events.length = 0
    await engine.invoke('ticket.setOwner', t.id, 'human')
    expect(events.some((e) => e.type === 'board.changed')).toBe(true)
    await clock.advance(1000)
    // The same owner again records nothing.
    await engine.invoke('ticket.setOwner', t.id, 'human')
    await engine.invoke('ticket.setOwner', t.id, 'agent')

    const after = await ticketOf(engine, t.id)
    expect(after.owner).toBe('agent')
    expect(after.runSettings).toEqual(before)
    expect(after.ownerChanges.map((c) => c.owner)).toEqual(['human', 'agent'])
  })

  test('an invalid owner is refused', async () => {
    const { engine } = await makeEngine()
    const t = await newTicket(engine)
    await expect(engine.invoke('ticket.setOwner', t.id, 'robot' as never)).rejects.toThrow()
    expect((await ticketOf(engine, t.id)).owner).toBe('agent')
  })

  test('a handed-back ticket starts as before', async () => {
    const { engine, runtime } = await makeEngine()
    const t = await humanTicket(engine)
    await engine.invoke('ticket.setOwner', t.id, 'agent')
    await engine.invoke('agent.start', t.id)
    await eventually(() => expect(runtime.specs).toHaveLength(1))
  })
})

describe('creating a ticket of your own, and converting both ways', () => {
  test('ticket.create with owner human makes a human ticket in Backlog or Ready; agents is the default', async () => {
    const { engine } = await makeEngine()
    const mine = await newTicket(engine, 'Mac run', 'backlog', { owner: 'human' })
    const inReady = await newTicket(engine, 'Account setup', 'ready', { owner: 'human', kind: 'change' })
    const ordinary = await newTicket(engine, 'Ordinary', 'ready')
    expect([mine.owner, inReady.owner, ordinary.owner]).toEqual(['human', 'human', 'agent'])
    expect((await ticketOf(engine, mine.id)).state.column).toBe('backlog')
    expect((await ticketOf(engine, inReady.id)).state.column).toBe('ready')
    expect((await ticketOf(engine, mine.id)).ownerChanges).toEqual([])
  })

  test('refuses a preset, start-when-ready and an invalid owner with a human owner', async () => {
    const { engine } = await makeEngine()
    await expect(newTicket(engine, 'A', 'ready', { owner: 'human', preset: 'Docs' })).rejects.toThrow("Presets are for agents' tickets")
    await expect(newTicket(engine, 'B', 'ready', { owner: 'human', startWhenReady: true })).rejects.toThrow("can't ask the orchestrator to start an agent")
    await expect(newTicket(engine, 'C', 'ready', { owner: 'robot' })).rejects.toThrow()
    expect((await engine.invoke('board.get')).tickets).toEqual([])
  })

  test('converting both ways keeps title, spec, criteria, run settings and rank', async () => {
    const { engine } = await makeEngine()
    const first = await newTicket(engine, 'First', 'ready', { spec: 'The spec', criteria: ['one', 'two'] })
    const second = await newTicket(engine, 'Second', 'ready')
    await engine.invoke('ticket.reorder', second.id, first.id)
    await engine.invoke('ticket.setRunSettings', first.id, { excludedRoleIds: [(await ticketOf(engine, first.id)).lineup.at(-1)!.id], roles: {}, extraInstructions: 'Careful' })
    await engine.invoke('ticket.update', first.id, { criteria: [{ position: 0, text: 'one', checked: true }, { position: 1, text: 'two', checked: false }] })
    const keep = async () => {
      const t = await ticketOf(engine, first.id)
      return { title: t.title, spec: t.spec, criteria: t.criteria, runSettings: t.runSettings, rank: t.rank, column: t.state.column }
    }
    const before = await keep()
    expect(before.runSettings).not.toBeNull()

    await engine.invoke('ticket.setOwner', first.id, 'human')
    expect(await keep()).toEqual(before)
    expect((await ticketOf(engine, first.id)).owner).toBe('human')
    await engine.invoke('ticket.setOwner', first.id, 'agent')
    expect(await keep()).toEqual(before)
    expect((await ticketOf(engine, first.id)).owner).toBe('agent')
  })
})

describe('propose_set_owner', () => {
  test('confirmed, converts the ticket; refused for a run open, Done and the same owner', async () => {
    const { engine, runtime } = await makeEngine()
    const t = await newTicket(engine)
    const tools = await liveTools(engine, runtime)
    expect(await tools.proposeSetOwner({ ticket: t.number, owner: 'human', reason: 'A hand check' })).toMatch(/^Proposed /)
    const [p] = (await engine.invoke('orchestrator.get')).proposals
    expect(p).toMatchObject({ kind: 'set_owner', payload: { number: t.number, owner: 'human', reason: 'A hand check' } })
    expect((await ticketOf(engine, t.id)).owner).toBe('agent')
    expect(await engine.invoke('proposal.confirm', p!.id)).toMatchObject({ status: 'confirmed', result: { owner: 'human' } })
    expect((await ticketOf(engine, t.id)).owner).toBe('human')

    expect(await tools.proposeSetOwner({ ticket: t.number, owner: 'human', reason: 'x' })).toMatch(/already belongs to the user/)
    expect(await tools.proposeSetOwner({ ticket: t.number, owner: 'agent', reason: 'Ready for it' })).toMatch(/^Proposed /)
    const back = (await engine.invoke('orchestrator.get')).proposals[1]!
    await engine.invoke('proposal.confirm', back.id)
    expect((await ticketOf(engine, t.id)).owner).toBe('agent')

    await engine.invoke('ticket.move', t.id, 'done')
    expect(await tools.proposeSetOwner({ ticket: t.number, owner: 'human', reason: 'x' })).toMatch(/is Done/)
  })
})
