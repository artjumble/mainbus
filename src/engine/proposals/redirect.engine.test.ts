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
let changed: number | null

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-redirect-'))
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

const failing = (n: number): FakeStep[] => [
  { emit: { kind: 'tool_call', id: `t${n}`, name: 'Bash', input: { command: 'npm test' } } },
  { emit: { kind: 'tool_result', id: `t${n}`, ok: false, summary: 'timed out' } }
]
/** The agent repeats a failing command, then goes quiet until it is sent something, and answers. */
const STUCK: FakeStep[] = [
  { emit: { kind: 'session', sessionId: 'role-sess' } },
  ...[1, 2, 3, 4, 5].flatMap(failing),
  { waitForSend: true },
  { emit: { kind: 'message', text: 'Checking the fixtures.' } },
  { waitForSend: true }
]
const ORCHESTRATOR: FakeStep[] = [{ emit: { kind: 'session', sessionId: 's' } }, { waitForSend: true }]

const MESSAGE = 'Timeouts are ruled out; check the shared fixtures instead.'

async function setup(opts: { stuck?: boolean } = {}) {
  const runtime = new FakeRuntime(STUCK, { orchestrator: ORCHESTRATOR })
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
  const ticket = await engine.invoke('ticket.create', { title: 'Login', intent: 'Add a login form', spec: '', criteria: [], labels: [], column: 'ready' })
  await engine.invoke('agent.start', ticket.id)
  await vi.waitFor(() => expect(runtime.specs).toHaveLength(1))
  await vi.waitFor(async () =>
    expect((await engine.invoke('thread.get', ticket.id)).events.filter((e) => e.event.kind === 'tool_result')).toHaveLength(5)
  )
  const board = async () => (await engine.invoke('board.get')).tickets.find((t) => t.id === ticket.id)!
  await engine.invoke('orchestrator.send', 'Login looks stuck')
  await vi.waitFor(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
  const tools = runtime.orchestratorSpecs[0]!.tools
  const proposals = async () => (await engine.invoke('orchestrator.get')).proposals
  if (opts.stuck !== false) {
    await clock.advance(3 * MIN)
    expect((await board()).stuck).toMatchObject({ rule: 'repeated_failure' })
  }
  const thread = async () => (await engine.invoke('thread.get', ticket.id)).events.map((e) => e.event)
  const propose = (message = MESSAGE) => tools.proposeRedirect({ ticket: ticket.number, message, evidence: 'The same command failed five times' })
  return { engine, runtime, ticket, tools, board, proposals, thread, propose }
}

describe('propose_redirect', () => {
  test('is valid only while the agent has an open stuck episode', async () => {
    const { tools, ticket, proposals, propose } = await setup({ stuck: false })
    expect(await propose()).toMatch(/^Invalid proposal: ticket: the Planner on #1 has no open stuck episode/)
    expect(await tools.proposeRedirect({ ticket: 99, message: 'x', evidence: 'y' })).toMatch(/there is no ticket #99/)
    expect(await tools.proposeRedirect({ ticket: ticket.number, message: '  ', evidence: 'y' })).toMatch(/^Invalid proposal: message: required/)
    expect(await tools.proposeRedirect({ ticket: ticket.number, message: 'x' })).toMatch(/^Invalid proposal: evidence: /)
    expect(await proposals()).toEqual([])
  })

  test('confirming interrupts the agent, sends the message as its next one and records it', async () => {
    const { engine, runtime, board, proposals, thread, propose } = await setup()
    expect(await propose()).toMatch(/^Proposed /)
    const [p] = await proposals()
    expect(p).toMatchObject({
      kind: 'redirect',
      status: 'pending',
      evidence: 'The same command failed five times',
      payload: { number: 1, role: 'Planner', message: MESSAGE, episodeEvidence: expect.arrayContaining([expect.stringContaining('Bash failed 5 times')]) }
    })
    // Nothing happens before the user confirms.
    expect(runtime.interrupted).toEqual([])

    const done = await engine.invoke('proposal.confirm', p!.id)
    expect(done).toMatchObject({ status: 'confirmed', result: { role: 'Planner', message: MESSAGE } })
    expect(runtime.interrupted).toHaveLength(1)
    await vi.waitFor(() => expect(runtime.sent).toContain(MESSAGE))
    expect(runtime.sent.filter((s) => s === MESSAGE)).toHaveLength(1)

    // Recorded as Mainbus's own entry, not as the user's message.
    const events = await thread()
    expect(events).toContainEqual({ kind: 'redirected', role: 'Planner', text: MESSAGE })
    expect(events.filter((e) => e.kind === 'user_message')).toEqual([])
    await vi.waitFor(async () => expect(await thread()).toContainEqual({ kind: 'message', text: 'Checking the fixtures.' }))

    expect((await board()).stuck).toMatchObject({ redirectedAt: expect.any(String) })
  })

  test('an override edits the message', async () => {
    const { engine, runtime, proposals, propose } = await setup()
    await propose()
    const [p] = await proposals()
    await expect(engine.invoke('proposal.confirm', p!.id, { message: '  ' })).rejects.toThrow()
    const done = await engine.invoke('proposal.confirm', p!.id, { message: 'Look at the fixtures in test/shared.' })
    expect(done).toMatchObject({ status: 'overridden', result: { message: 'Look at the fixtures in test/shared.' } })
    await vi.waitFor(() => expect(runtime.sent).toContain('Look at the fixtures in test/shared.'))
    expect(runtime.sent).not.toContain(MESSAGE)
  })

  test('a second redirect in the same episode is refused, pointing to a replacement', async () => {
    const { engine, proposals, propose } = await setup()
    await propose()
    await engine.invoke('proposal.confirm', (await proposals())[0]!.id)
    expect(await propose('Again')).toMatch(/^Invalid proposal: .*already been redirected once; propose a replacement instead/)
    expect(await proposals()).toHaveLength(1)
  })

  test('of two pending proposals for one episode, only the first confirmed goes through', async () => {
    const { engine, runtime, proposals, propose } = await setup()
    await propose('First')
    await propose('Second')
    const [a, b] = await proposals()
    await engine.invoke('proposal.confirm', a!.id)
    const second = await engine.invoke('proposal.confirm', b!.id)
    expect(second).toMatchObject({ status: 'failed', result: { error: expect.stringContaining('already been redirected') } })
    expect(runtime.interrupted).toHaveLength(1)
    expect(runtime.sent.filter((s) => s === 'First' || s === 'Second')).toEqual(['First'])
  })

  test('a proposal stale by confirmation fails with the reason, without interrupting anything', async () => {
    const { engine, runtime, board, proposals, propose } = await setup()
    await propose()
    // The agent shows progress: the episode closes.
    changed = clock.now().getTime() + 1
    await clock.advance(MIN)
    expect((await board()).stuck).toBeNull()

    const [p] = await proposals()
    const done = await engine.invoke('proposal.confirm', p!.id)
    expect(done).toMatchObject({ status: 'failed', result: { error: expect.stringContaining('no longer stuck') } })
    expect(done.result).toMatchObject({ error: expect.stringContaining('Nothing was interrupted') })
    expect(runtime.interrupted).toEqual([])
    expect(runtime.sent).not.toContain(MESSAGE)
  })

  test('a run that has ended fails the proposal, without interrupting anything', async () => {
    const { engine, runtime, ticket, proposals, propose } = await setup()
    await propose()
    await engine.invoke('agent.stop', ticket.id)
    const interruptedBefore = runtime.interrupted.length
    const [p] = await proposals()
    const done = await engine.invoke('proposal.confirm', p!.id)
    expect(done).toMatchObject({ status: 'failed', result: { error: expect.stringContaining('Nothing was interrupted') } })
    expect(runtime.interrupted).toHaveLength(interruptedBefore)
    expect(runtime.sent).not.toContain(MESSAGE)
  })

  test('the orchestrator learns the episode was redirected', async () => {
    const { engine, tools, ticket, proposals, propose } = await setup()
    expect(await tools.getRunStatus({ number: ticket.number })).not.toContain('already redirected')
    await propose()
    await engine.invoke('proposal.confirm', (await proposals())[0]!.id)
    expect(await tools.getRunStatus({ number: ticket.number })).toContain('already redirected once')
    expect(await tools.getRecentEvents({ number: ticket.number })).toContain('The user redirected the Planner')
  })
})
