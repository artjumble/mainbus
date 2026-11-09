import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runGit } from '../git/git'
import { FakeClock } from '../holds/clock'
import { resolveHome, type HomePaths } from '../home'
import { createEngine, type Engine } from '../index'
import { makeRepo } from '../intake/testBoard'
import { FAKE_SUMMARY, FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import type { ExecFn } from '../runtime/resolveClaude'
import { eventually } from '../testWait'

// Each test starts an engine over a real repository: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })
const START = new Date('2026-11-02T09:00:00.000Z')
const MIN = 60_000

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]
let clock: FakeClock

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-replace-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  engines = []
  clock = new FakeClock(START)
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const failing = (n: number): FakeStep[] => [
  { emit: { kind: 'tool_call', id: `t${n}`, name: 'Bash', input: { command: 'npm test' } } },
  { emit: { kind: 'tool_result', id: `t${n}`, ok: false, summary: 'timed out' } }
]
/** Every agent repeats a failing command, then goes quiet until it is sent something. */
const STUCK: FakeStep[] = [
  { emit: { kind: 'session', sessionId: 'role-sess' } },
  ...[1, 2, 3, 4, 5].flatMap(failing),
  { waitForSend: true },
  { emit: { kind: 'message', text: 'Checking the fixtures.' } },
  { waitForSend: true }
]
const ORCHESTRATOR: FakeStep[] = [{ emit: { kind: 'session', sessionId: 's' } }, { waitForSend: true }]

const REDIRECT = 'Timeouts are ruled out; check the shared fixtures instead.'

async function setup() {
  const runtime = new FakeRuntime(STUCK, { orchestrator: ORCHESTRATOR })
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec, clock, stuck: { timer: clock, newestChange: async () => null } })
  engines.push(engine)
  await engine.invoke('workspace.open', repoPath)
  const ticket = await engine.invoke('ticket.create', { title: 'Login', intent: 'Add a login form', spec: '', criteria: ['It logs in'], labels: [], column: 'ready' })
  await engine.invoke('agent.start', ticket.id)
  const agentsStuck = (n: number) =>
    eventually(async () => {
      expect(runtime.specs).toHaveLength(n)
      const events = (await engine.invoke('thread.get', ticket.id)).events
      expect(events.filter((e) => e.event.kind === 'tool_result')).toHaveLength(5 * n)
    })
  await agentsStuck(1)
  const board = async () => (await engine.invoke('board.get')).tickets.find((t) => t.id === ticket.id)!
  await engine.invoke('orchestrator.send', 'Login looks stuck')
  await eventually(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
  const tools = runtime.orchestratorSpecs[0]!.tools
  const proposals = async () => (await engine.invoke('orchestrator.get')).proposals
  const threadRuns = async () => (await engine.invoke('thread.get', ticket.id)).runs
  /** The ticket's stuck evidence appears after a few quiet minutes. */
  const noticeStuck = async () => {
    await clock.advance(3 * MIN)
    expect((await board()).stuck).toMatchObject({ rule: 'repeated_failure' })
  }
  const proposeReplace = () =>
    tools.proposeReplace({ ticket: ticket.number, reason: 'A fresh agent will not repeat the dead end', evidence: 'The redirect did not help' })
  return { engine, runtime, ticket, tools, board, proposals, threadRuns, agentsStuck, noticeStuck, proposeReplace }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** Redirects the stuck agent, then lets it fire again: the step before a replacement. */
async function redirectAndFireAgain(s: Setup): Promise<void> {
  await s.noticeStuck()
  await s.tools.proposeRedirect({ ticket: s.ticket.number, message: REDIRECT, evidence: 'The same command failed five times' })
  const [p] = await s.proposals()
  await s.engine.invoke('proposal.confirm', p!.id)
  await eventually(() => expect(s.runtime.sent).toContain(REDIRECT))
  await clock.advance(6 * MIN)
  await eventually(async () => expect((await s.board()).stuck?.hitCount).toBeGreaterThan(1))
}

describe('propose_replace', () => {
  test('is refused until a redirected episode fires again', async () => {
    const s = await setup()
    expect(await s.proposeReplace()).toMatch(/^Invalid proposal: ticket: the Planner on #1 has no open stuck episode/)
    await s.noticeStuck()
    expect(await s.proposeReplace()).toMatch(/has not been redirected yet; propose a redirect first/)

    await s.tools.proposeRedirect({ ticket: s.ticket.number, message: REDIRECT, evidence: 'The same command failed five times' })
    await s.engine.invoke('proposal.confirm', (await s.proposals())[0]!.id)
    await eventually(() => expect(s.runtime.sent).toContain(REDIRECT))
    expect(await s.proposeReplace()).toMatch(/redirected and has not fired again since/)
    expect((await s.proposals()).filter((p) => p.kind === 'replace')).toEqual([])
  })

  test('is accepted once the redirected episode fires again, and the orchestrator is told', async () => {
    const s = await setup()
    await redirectAndFireAgain(s)
    expect(await s.tools.getRunStatus({ number: s.ticket.number })).toContain('has fired again: propose a replacement')
    expect(await s.proposeReplace()).toMatch(/^Proposed /)
    const [, p] = await s.proposals()
    expect(p).toMatchObject({
      kind: 'replace',
      status: 'pending',
      origin: 'orchestrator',
      evidence: 'The redirect did not help',
      payload: { number: 1, role: 'Planner', episodeEvidence: expect.arrayContaining([expect.stringContaining('Bash failed 5 times')]) }
    })
    // Nothing happens before the user decides.
    expect(s.runtime.specs).toHaveLength(1)
  })

  test('confirming replaces the agent: the old run ends as replaced and a fresh one starts with the summary', async () => {
    const s = await setup()
    await redirectAndFireAgain(s)
    await s.proposeReplace()
    const done = await s.engine.invoke('proposal.confirm', (await s.proposals())[1]!.id)
    expect(done).toMatchObject({ status: 'confirmed', result: { role: 'Planner' } })
    await s.agentsStuck(2)

    const runs = await s.threadRuns()
    expect(runs).toHaveLength(2)
    expect(runs[0]!.ticketRunId).toBe(runs[1]!.ticketRunId)
    const spec = s.runtime.specs[1]!
    expect(spec.resumeSessionId).toBeUndefined()
    expect(spec.prompt).toContain('Handoff from the previous run')
    expect(spec.prompt).toContain(FAKE_SUMMARY)
    expect(spec.cwd).toBe(s.runtime.specs[0]!.cwd)
    expect(s.runtime.summaries).toHaveLength(1)

    // Its stuck episode ended with it, and the orchestrator hears what happened.
    expect((await s.board()).stuck).toBeNull()
    const events = (await s.engine.invoke('thread.get', s.ticket.id)).events.map((e) => e.event)
    expect(events).toContainEqual({
      kind: 'replaced',
      role: 'Planner',
      summary: FAKE_SUMMARY,
      source: 'summary',
      proposalId: (await s.proposals())[1]!.id,
      suggestedBy: 'orchestrator'
    })
    expect(await s.tools.getRecentEvents({ number: s.ticket.number })).toContain('The user replaced the Planner')
  })

  test('an override changes the new run’s model, effort and extra instructions', async () => {
    const s = await setup()
    await redirectAndFireAgain(s)
    await s.proposeReplace()
    const [, p] = await s.proposals()
    await expect(s.engine.invoke('proposal.confirm', p!.id, { model: 'gpt', effort: 'low', extraInstructions: '' })).rejects.toThrow()
    const done = await s.engine.invoke('proposal.confirm', p!.id, { model: 'haiku', effort: 'low', extraInstructions: 'Check the fixtures first' })
    expect(done).toMatchObject({ status: 'overridden', result: { model: 'haiku', effort: 'low' } })
    await s.agentsStuck(2)
    expect(s.runtime.specs[1]).toMatchObject({ model: 'haiku', effort: 'low' })
    expect(s.runtime.specs[1]!.appendSystemPrompt).toContain('Check the fixtures first')
  })

  test('Keep current rejects it, and the agent carries on', async () => {
    const s = await setup()
    await redirectAndFireAgain(s)
    await s.proposeReplace()
    const rejected = await s.engine.invoke('proposal.reject', (await s.proposals())[1]!.id)
    expect(rejected.status).toBe('rejected')
    expect(s.runtime.specs).toHaveLength(1)
    expect((await s.board()).state.agentStatus).toBe('working')
  })
})

describe('the Replace… button', () => {
  test('makes the proposal at any time, with no episode and no orchestrator turn', async () => {
    const s = await setup()
    expect((await s.board()).stuck).toBeNull()
    const turns = s.runtime.sent.length
    const p = await s.engine.invoke('ticket.proposeReplace', s.ticket.id)
    expect(p).toMatchObject({
      kind: 'replace',
      status: 'pending',
      origin: 'button',
      payload: { number: 1, role: 'Planner', episodeId: null, episodeEvidence: [] }
    })
    expect(s.runtime.sent.length).toBe(turns)
    // Asked twice, the same pending card comes back.
    expect(await s.engine.invoke('ticket.proposeReplace', s.ticket.id)).toMatchObject({ id: p.id })

    const done = await s.engine.invoke('proposal.confirm', p.id)
    expect(done).toMatchObject({ status: 'confirmed', result: { role: 'Planner' } })
    await s.agentsStuck(2)
    expect(s.runtime.specs[1]!.prompt).toContain('Handoff from the previous run')
    expect((await s.threadRuns()).length).toBe(2)
    const events = (await s.engine.invoke('thread.get', s.ticket.id)).events.map((e) => e.event)
    expect(events).toContainEqual(expect.objectContaining({ kind: 'replaced', proposalId: p.id, suggestedBy: 'user' }))
  })

  test('is refused for a ticket with no open run', async () => {
    const s = await setup()
    await s.engine.invoke('agent.stop', s.ticket.id)
    await expect(s.engine.invoke('ticket.proposeReplace', s.ticket.id)).rejects.toThrow(/no active role/)
  })
})

describe('a role replaced twice that gets stuck again', () => {
  test('is marked Failed, the ticket needs you, with a plain account of what was tried', async () => {
    const s = await setup()
    // Replace the agent twice with the button, as the user may at any time.
    for (const n of [2, 3]) {
      const p = await s.engine.invoke('ticket.proposeReplace', s.ticket.id)
      await s.engine.invoke('proposal.confirm', p.id)
      await s.agentsStuck(n)
    }

    // The third agent gets stuck as well: no more redirects or replacements are offered.
    await clock.advance(3 * MIN)
    await eventually(async () => expect((await s.board()).state).toMatchObject({ column: 'needs_you', agentStatus: 'failed' }))
    const board = await s.board()
    expect(board.stuck).toBeNull()
    expect(board.state.summary).toContain('replaced 2 times')
    const errors = (await s.engine.invoke('thread.get', s.ticket.id)).events.flatMap((e) => (e.event.kind === 'error' ? [e.event.message] : []))
    const events = (await s.engine.invoke('thread.get', s.ticket.id)).events.map((e) => e.event.kind)
    // The Failed outcome is its own entry, just before the error that explains it.
    expect(events.slice(-2)).toEqual(['stuck_failed', 'error'])
    expect(errors.at(-1)).toContain('It looked stuck (the same command failing again and again)')
    expect(errors.at(-1)).toContain('It was then replaced by a fresh agent.')
    expect(await s.tools.proposeReplace({ ticket: 1, reason: 'x', evidence: 'y' })).toMatch(/no active role/)
  })

  test('is not failed while the role has been replaced fewer times', async () => {
    const s = await setup()
    const p = await s.engine.invoke('ticket.proposeReplace', s.ticket.id)
    await s.engine.invoke('proposal.confirm', p.id)
    await s.agentsStuck(2)
    await clock.advance(3 * MIN)
    await eventually(async () => expect((await s.board()).stuck).toMatchObject({ rule: 'repeated_failure' }))
    expect((await s.board()).state.agentStatus).toBe('working')
  })
})
