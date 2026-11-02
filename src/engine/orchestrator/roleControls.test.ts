import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runGit } from '../git/git'
import { resolveHome, type HomePaths } from '../home'
import { createEngine, type Engine } from '../index'
import { makeRepo } from '../intake/testBoard'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import type { ExecFn } from '../runtime/resolveClaude'

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-controls-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  engines = []
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function makeEngine(runtime: FakeRuntime): Promise<Engine> {
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec })
  engines.push(engine)
  await engine.invoke('workspace.open', repoPath)
  return engine
}

const turnEnd = (): FakeStep => ({ emit: { kind: 'turn_end', ok: true } })
const newTicket = (engine: Engine, column: 'backlog' | 'ready', title = 'Login') =>
  engine.invoke('ticket.create', { title, intent: 'Add a login form', spec: '', criteria: [], labels: [], column })

describe('pause, stop and skip proposals', () => {
  const WORKING: FakeStep[] = [{ emit: { kind: 'session', sessionId: 'role-sess' } }, { waitForSend: true }]

  /** A started ticket whose first role is working, and an orchestrator turn left open to propose in. */
  async function running() {
    const runtime = new FakeRuntime(WORKING, {
      orchestrator: [{ emit: { kind: 'session', sessionId: 'sess-1' } }, { waitForSend: true }]
    })
    const engine = await makeEngine(runtime)
    const t = await newTicket(engine, 'ready')
    await engine.invoke('agent.start', t.id)
    await engine.invoke('orchestrator.send', 'Look at the login ticket')
    await vi.waitFor(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    const tools = runtime.orchestratorSpecs[0]!.tools
    const state = async () => (await engine.invoke('board.get')).tickets.find((x) => x.id === t.id)!.state
    await vi.waitFor(async () => expect((await state()).agentStatus).toBe('working'))
    const proposals = async () => (await engine.invoke('orchestrator.get')).proposals
    return { runtime, engine, t, tools, state, proposals }
  }

  test('validates against the ticket, and needs a reason', async () => {
    const { engine, t, tools, proposals } = await running()
    expect(await tools.proposePause({ ticket: t.number })).toBe(
      'Invalid proposal: reason: required. Nothing was stored; fix it and propose again.'
    )
    expect(await tools.proposeStop({ ticket: 99, reason: 'x' })).toMatch(/^Invalid proposal: ticket: there is no ticket #99/)
    const idle = await newTicket(engine, 'ready', 'Idle')
    for (const tool of [tools.proposePause, tools.proposeStop, tools.proposeSkip]) {
      expect(await tool({ ticket: idle.number, reason: 'x' })).toMatch(/^Invalid proposal: ticket: #\d+ has no (working role|run)/)
    }
    expect(await proposals()).toEqual([])
  })

  test('pause, confirmed, does what the ticket view does; an override is refused and leaves it pending', async () => {
    const { engine, t, tools, state, proposals } = await running()
    await tools.proposePause({ ticket: t.number, reason: 'It is going the wrong way' })
    const [p] = await proposals()
    expect(p).toMatchObject({
      kind: 'pause',
      origin: 'orchestrator',
      evidence: 'It is going the wrong way',
      payload: { role: 'Planner', number: t.number }
    })
    await expect(engine.invoke('proposal.confirm', p!.id, {})).rejects.toThrow('This proposal has nothing to change')
    expect((await proposals())[0]!.status).toBe('pending')

    const done = await engine.invoke('proposal.confirm', p!.id)
    expect(done).toMatchObject({ status: 'confirmed', result: { role: 'Planner', number: t.number } })
    expect(await state()).toMatchObject({ agentStatus: 'paused', pausedByUser: true })
  })

  test('stop, confirmed, ends the run and puts the ticket back in Ready', async () => {
    const { engine, t, tools, state, proposals } = await running()
    await tools.proposeStop({ ticket: t.number, reason: 'Wrong ticket' })
    const done = await engine.invoke('proposal.confirm', (await proposals())[0]!.id)
    expect(done.status).toBe('confirmed')
    expect((await state()).column).toBe('ready')
  })

  test('skip, confirmed, starts the next role', async () => {
    const { engine, runtime, t, tools, proposals } = await running()
    await tools.proposeSkip({ ticket: t.number, reason: 'Planning is done' })
    const [p] = await proposals()
    expect(p!.payload).toMatchObject({ role: 'Planner', next: 'Implementer' })
    const done = await engine.invoke('proposal.confirm', p!.id)
    expect(done).toMatchObject({ status: 'confirmed', result: { role: 'Planner', next: 'Implementer' } })
    await vi.waitFor(() => expect(runtime.specs).toHaveLength(2))
    expect(runtime.specs[1]!.role).toBe('Implementer')
  })

  test('a proposal whose role has moved on fails with a clear result and acts on no other role', async () => {
    const { engine, runtime, t, tools, state, proposals } = await running()
    await tools.proposeSkip({ ticket: t.number, reason: 'Planning is done' })
    await tools.proposePause({ ticket: t.number, reason: 'Hold on' })
    const [skipP, pauseP] = await proposals()
    // The user skips the Planner by hand first: the Implementer is now the active role.
    await engine.invoke('agent.skip', t.id)
    await vi.waitFor(() => expect(runtime.specs).toHaveLength(2))
    await vi.waitFor(async () => expect((await state()).agentStatus).toBe('working'))

    const failedSkip = await engine.invoke('proposal.confirm', skipP!.id)
    expect(failedSkip.status).toBe('failed')
    expect((failedSkip.result as { error: string }).error).toBe(
      `#${t.number} has moved on since this was proposed: the Planner is no longer its active role (now: the Implementer). Nothing was skipped.`
    )
    const failedPause = await engine.invoke('proposal.confirm', pauseP!.id)
    expect(failedPause.status).toBe('failed')
    expect((failedPause.result as { error: string }).error).toContain('Nothing was paused.')
    // The Implementer was left alone.
    expect(runtime.specs).toHaveLength(2)
    expect(await state()).toMatchObject({ agentStatus: 'working' })
  })

  test('a stop proposal after the run ended fails', async () => {
    const { engine, t, tools, proposals } = await running()
    await tools.proposeStop({ ticket: t.number, reason: 'Wrong ticket' })
    await engine.invoke('agent.stop', t.id)
    const failed = await engine.invoke('proposal.confirm', (await proposals())[0]!.id)
    expect(failed.status).toBe('failed')
    expect((failed.result as { error: string }).error).toContain('the run has ended')
  })
})

describe('a card dragged into In progress', () => {
  test('proposes starting the whole lineup with no orchestrator turn, even before any message', async () => {
    const runtime = new FakeRuntime([{ waitForSend: true }], { orchestrator: [turnEnd()] })
    const engine = await makeEngine(runtime)
    const t = await newTicket(engine, 'backlog')

    const p = await engine.invoke('ticket.proposeStart', t.id)

    expect(p).toMatchObject({ kind: 'start_lineup', origin: 'drag', status: 'pending', payload: { ticketId: t.id } })
    expect((p.payload as { roles: { name: string }[] }).roles.map((r) => r.name)).toEqual(['Planner', 'Implementer', 'Reviewer'])
    expect(p.evidence).toBe(`You dragged #${t.number} "Login" into In progress.`)
    const thread = await engine.invoke('orchestrator.get')
    expect(thread.events.map((e) => e.event)).toEqual([{ kind: 'proposal', proposalId: p.id, from: 'drag' }])
    expect(thread.status).toBe('idle')
    expect(runtime.orchestratorSpecs).toEqual([])
    // The card stays in its column until the proposal is confirmed.
    expect((await engine.invoke('board.get')).tickets[0]!.state.column).toBe('backlog')

    // A second drag shows the same card rather than another.
    expect((await engine.invoke('ticket.proposeStart', t.id)).id).toBe(p.id)
    expect((await engine.invoke('orchestrator.get')).proposals).toHaveLength(1)

    await engine.invoke('proposal.confirm', p.id)
    await vi.waitFor(() => expect(runtime.specs).toHaveLength(1))
    expect((await engine.invoke('board.get')).tickets[0]!.state.column).toBe('in_progress')
    await expect(engine.invoke('ticket.proposeStart', t.id)).rejects.toThrow(`#${t.number} is already running`)
  })

  test('mid-turn it sends nothing to the orchestrator; its next message hears the outcome as a drag', async () => {
    const runtime = new FakeRuntime([{ waitForSend: true }], {
      orchestrator: [{ emit: { kind: 'session', sessionId: 'sess-1' } }, turnEnd(), { waitForSend: true }, turnEnd()]
    })
    const engine = await makeEngine(runtime)
    const t = await newTicket(engine, 'backlog')
    await engine.invoke('orchestrator.send', 'Hello')
    await vi.waitFor(async () => expect((await engine.invoke('orchestrator.get')).status).toBe('idle'))

    const p = await engine.invoke('ticket.proposeStart', t.id)
    expect((await engine.invoke('orchestrator.get')).status).toBe('idle')
    expect(runtime.sent).toHaveLength(0)
    await engine.invoke('proposal.reject', p.id)
    expect((await engine.invoke('board.get')).tickets[0]!.state.column).toBe('backlog')

    await engine.invoke('orchestrator.send', 'Any news?')
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
    expect(runtime.sent[0]!).toContain(
      `- Proposal ${p.id} (start a ticket, made by the user dragging the card into In progress): rejected by the user.`
    )
  })

  test('refuses an unknown ticket', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    await expect(engine.invoke('ticket.proposeStart', 'nope')).rejects.toThrow()
  })
})
