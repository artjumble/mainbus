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
import { eventually } from '../testWait'

// Each test starts an engine over a real repository: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })
const START = new Date('2026-11-02T09:00:00.000Z')

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-answer-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  engines = []
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const ASKING: FakeStep[] = [
  { emit: { kind: 'session', sessionId: 'role-sess' } },
  { callTool: 'askUser', args: { question: 'Which API?', options: ['Old API', 'New API'] } },
  { emit: { kind: 'turn_end', ok: true } },
  { waitForSend: true }
]
const ORCHESTRATOR: FakeStep[] = [{ emit: { kind: 'session', sessionId: 's' } }, { waitForSend: true }]

const JUDGEMENT = {
  reason: 'open_question',
  requirement: 'Add a login form',
  proposed: 'Use the new API',
  smallest_option: 'Old API',
  consequences: [
    { option: 'Old API', consequence: 'Nothing changes' },
    { option: 'New API', consequence: 'A migration is needed' }
  ],
  recommendation: 'Old API'
}

/** An engine with a started ticket whose agent asked, and the orchestrator in a turn with its tools. */
async function setup() {
  const runtime = new FakeRuntime(ASKING, { orchestrator: ORCHESTRATOR })
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec, clock: new FakeClock(START) })
  engines.push(engine)
  await engine.invoke('workspace.open', repoPath)
  const ticket = await engine.invoke('ticket.create', { title: 'Login', intent: 'Add a login form', spec: '', criteria: [], labels: [], column: 'ready' })
  await engine.invoke('agent.start', ticket.id)
  const board = async () => (await engine.invoke('board.get')).tickets.find((t) => t.id === ticket.id)!
  await eventually(async () => expect((await board()).pendingDecisions).toHaveLength(1))
  const decision = (await board()).pendingDecisions[0]!
  await engine.invoke('orchestrator.send', 'Use the new API for login')
  await eventually(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
  const tools = runtime.orchestratorSpecs[0]!.tools
  const proposals = async () => (await engine.invoke('orchestrator.get')).proposals
  const heard = () => runtime.sent.filter((s) => s.includes('Answer:'))
  return { engine, runtime, ticket, decision, tools, board, proposals, heard }
}

describe('propose_answer', () => {
  test('confirmed, answers the decision from the orchestrator and the agent hears it once', async () => {
    const { engine, tools, decision, proposals, heard, board } = await setup()
    expect(await tools.proposeAnswer({ decision: decision.id, choice: 2, reasoning: 'You said the new API' })).toMatch(/^Proposed /)
    const [p] = await proposals()
    expect(p).toMatchObject({ kind: 'answer', status: 'pending', evidence: 'You said the new API', payload: { choice: 1, question: 'Which API?' } })
    expect((await board()).pendingDecisions).toHaveLength(1)

    const done = await engine.invoke('proposal.confirm', p!.id)
    expect(done).toMatchObject({ status: 'confirmed', result: { answer: 'New API' } })
    expect((await board()).pendingDecisions).toHaveLength(0)
    const thread = await engine.invoke('thread.get', (await board()).id)
    expect(thread.decisions[0]).toMatchObject({ status: 'answered', answer: { kind: 'option', index: 1 }, answeredVia: 'orchestrator' })
    await eventually(() => expect(heard()).toEqual(['Answer: New API']))
  })

  test('an override answers with the other option and note', async () => {
    const { engine, tools, decision, proposals, heard } = await setup()
    await tools.proposeAnswer({ decision: decision.id, choice: 2, reasoning: 'Because' })
    const [p] = await proposals()
    const done = await engine.invoke('proposal.confirm', p!.id, { choice: 0, note: 'Keep it simple' })
    expect(done).toMatchObject({ status: 'overridden', result: { answer: 'Old API', note: 'Keep it simple' } })
    await eventually(() => expect(heard()).toEqual(['Answer: Old API\nNote: Keep it simple']))
  })

  test('an invalid proposal stores nothing and says why', async () => {
    const { tools, decision, proposals } = await setup()
    expect(await tools.proposeAnswer({ decision: decision.id, choice: 3, reasoning: 'x' })).toMatch(/^Invalid proposal: choice: must be one of the 2 options/)
    expect(await tools.proposeAnswer({ decision: 'nope', choice: 1, reasoning: 'x' })).toMatch(/^Invalid proposal: decision: there is no decision nope/)
    expect(await tools.proposeAnswer({ decision: decision.id, choice: 1 })).toMatch(/^Invalid proposal: reasoning: required/)
    expect(await proposals()).toEqual([])
  })

  test('a decision answered from the board meanwhile turns the proposal into a failed receipt, and nothing is answered twice', async () => {
    const { engine, tools, decision, proposals, heard } = await setup()
    await tools.proposeAnswer({ decision: decision.id, choice: 2, reasoning: 'Because' })
    const [p] = await proposals()
    await engine.invoke('decision.answer', decision.id, { kind: 'option', index: 0 }, 'board')

    await eventually(async () => expect((await proposals())[0]).toMatchObject({ status: 'failed', result: { error: 'Already answered from the board' } }))
    await expect(engine.invoke('proposal.confirm', p!.id)).rejects.toThrow(/not pending/)
    await eventually(() => expect(heard()).toEqual(['Answer: Old API']))
    expect(await tools.proposeAnswer({ decision: decision.id, choice: 2, reasoning: 'Again' })).toMatch(/Already answered from the board/)
  })

  test('a decision deferred meanwhile fails the proposal with the date', async () => {
    const { engine, tools, decision, proposals } = await setup()
    await tools.proposeAnswer({ decision: decision.id, choice: 2, reasoning: 'Because' })
    await engine.invoke('decision.defer', decision.id, new Date(START.getTime() + 24 * 60 * 60 * 1000).toISOString())
    await eventually(async () => expect((await proposals())[0]).toMatchObject({ status: 'failed' }))
    expect(((await proposals())[0]!.result as { error: string }).error).toMatch(/^Deferred until /)
  })

  test('a judgement is answered only by the user choosing an option', async () => {
    const { engine, tools, decision, proposals, heard } = await setup()
    await tools.proposeAnswer({ decision: decision.id, choice: 1, reasoning: 'Open question', judgement: JUDGEMENT })
    const [p] = await proposals()
    expect(p!.payload).toMatchObject({ choice: 0, judgement: { reason: 'open_question' } })

    const failed = await engine.invoke('proposal.confirm', p!.id)
    expect(failed).toMatchObject({ status: 'failed' })
    expect(heard()).toEqual([])
  })

  test('a judgement with the user choosing answers the decision', async () => {
    const { engine, tools, decision, proposals, heard } = await setup()
    await tools.proposeAnswer({ decision: decision.id, reasoning: 'Open question', judgement: JUDGEMENT })
    const [p] = await proposals()
    expect(p!.payload).toMatchObject({ choice: null })
    expect(await engine.invoke('proposal.confirm', p!.id, { choice: 1 })).toMatchObject({ status: 'overridden', result: { answer: 'New API' } })
    await eventually(() => expect(heard()).toEqual(['Answer: New API']))
  })
})
