import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { EngineEvent } from '../../shared/api'
import { runGit } from '../git/git'
import { FakeClock } from '../holds/clock'
import { resolveHome, type HomePaths } from '../home'
import { createEngine, type Engine } from '../index'
import { makeRepo } from '../intake/testBoard'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import type { ExecFn } from '../runtime/resolveClaude'
import type { RunSpec } from '../runtime/types'

vi.setConfig({ testTimeout: 30_000 })

/** vi.waitFor with room for a loaded machine: a launch makes a git worktree. */
const waitFor: typeof vi.waitFor = (fn, options) => vi.waitFor(fn, { timeout: 10_000, ...(typeof options === 'object' ? options : {}) })

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

const START = new Date('2026-11-02T09:00:00.000Z')
const HOUR = 3_600_000
const RESET_SECONDS = Math.floor((START.getTime() + HOUR) / 1000)

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]
let clock: FakeClock

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-usage-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  engines = []
  clock = new FakeClock(START)
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const session = (id: string): FakeStep => ({ emit: { kind: 'session', sessionId: id } })

/** Ticket A hits the limit when it is sent a message; everything else just works; a resumed session waits quietly. */
function script(spec: RunSpec): FakeStep[] {
  if (spec.resumeSessionId) return [session(spec.resumeSessionId), { waitForSend: true }]
  const id = `sess-${path.basename(spec.cwd)}`
  if (!spec.cwd.endsWith('-a')) return [session(id), { waitForSend: true }]
  return [
    session(id),
    { waitForSend: true },
    { emit: { kind: 'rate_limit', status: 'rejected', resetsAt: RESET_SECONDS, windows: {} } },
    { emit: { kind: 'turn_end', ok: false, error: 'Claude AI usage limit reached' } },
    { waitForSend: true }
  ]
}

async function makeEngine(runtime: FakeRuntime): Promise<{ engine: Engine; events: EngineEvent[] }> {
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec, clock })
  engines.push(engine)
  if (!(await engine.invoke('workspace.get'))) await engine.invoke('workspace.open', repoPath)
  const events: EngineEvent[] = []
  engine.on((e) => events.push(e))
  return { engine, events }
}

const board = async (engine: Engine) => (await engine.invoke('board.get')).tickets
const stateOf = async (engine: Engine, title: string) => (await board(engine)).find((t) => t.title === title)!.state
const create = (engine: Engine, title: string) =>
  engine.invoke('ticket.create', { title, intent: 'x', spec: '', criteria: [], labels: [], column: 'ready' })

/** Two tickets, A and B, working; A is sent a message and runs into the limit, which pauses both. */
async function limited(runtime: FakeRuntime) {
  const { engine, events } = await makeEngine(runtime)
  const a = await create(engine, 'A')
  const b = await create(engine, 'B')
  await engine.invoke('agent.start', a.id)
  await engine.invoke('agent.start', b.id)
  await waitFor(() => expect(runtime.specs).toHaveLength(2))
  await engine.invoke('agent.send', a.id, 'go')
  await waitFor(async () => {
    expect(await stateOf(engine, 'A')).toMatchObject({ agentStatus: 'paused', pausedByLimit: true })
    expect(await stateOf(engine, 'B')).toMatchObject({ agentStatus: 'paused', pausedByLimit: true })
  })
  return { engine, events, a, b }
}

describe('the usage limit in the engine', () => {
  test('usage.get tells where the app stands, usage.changed announces it, and Resume now resumes everyone at once', async () => {
    const runtime = new FakeRuntime(script)
    expect(await (await makeEngine(new FakeRuntime([]))).engine.invoke('usage.get')).toEqual({ kind: 'ok' })
    const { engine, events } = await limited(runtime)

    expect(await engine.invoke('usage.get')).toEqual({
      kind: 'limited',
      resetsAt: new Date(RESET_SECONDS * 1000).toISOString(),
      retryAt: null,
      paused: 2
    })
    expect(events.some((e) => e.type === 'usage.changed' && e.state.kind === 'limited' && e.state.paused === 2)).toBe(true)
    // Nothing needs the user.
    expect((await board(engine)).filter((t) => t.state.column === 'needs_you')).toEqual([])

    await engine.invoke('usage.resumeNow')

    await waitFor(() => expect(runtime.specs).toHaveLength(4))
    await waitFor(async () => {
      expect(await stateOf(engine, 'A')).toMatchObject({ agentStatus: 'working' })
      expect(await stateOf(engine, 'B')).toMatchObject({ agentStatus: 'working' })
    })
    expect(await engine.invoke('usage.get')).toEqual({ kind: 'ok' })
    expect(events.at(-1)).toMatchObject({ type: 'board.changed' })
    expect(events.filter((e) => e.type === 'usage.changed').at(-1)).toEqual({ type: 'usage.changed', state: { kind: 'ok' } })
  })

  test('the limit and the paused agents survive a restart, none is restarted, and the reset resumes them in order', async () => {
    const first = await limited(new FakeRuntime(script))
    await first.engine.dispose()

    const runtime2 = new FakeRuntime(script)
    const { engine } = await makeEngine(runtime2)
    await waitFor(async () => expect(await engine.invoke('usage.get')).toMatchObject({ kind: 'limited', paused: 2 }))
    // Recovery has run its course without restarting anyone.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(runtime2.specs).toHaveLength(0)
    expect(await stateOf(engine, 'A')).toMatchObject({ agentStatus: 'paused', pausedByLimit: true })
    expect(await stateOf(engine, 'B')).toMatchObject({ agentStatus: 'paused', pausedByLimit: true })

    await clock.advance(HOUR)

    await waitFor(() => expect(runtime2.specs).toHaveLength(2))
    expect(runtime2.specs.map((s) => path.basename(s.cwd).replace(/^\d+-/, ''))).toEqual(['a', 'b'])
    expect(await engine.invoke('usage.get')).toEqual({ kind: 'ok' })
  })

  test('an orchestrator turn that runs into the limit pauses the agents too', async () => {
    const runtime = new FakeRuntime(script, {
      orchestrator: [
        session('orch'),
        { emit: { kind: 'rate_limit', status: 'rejected', resetsAt: RESET_SECONDS, windows: {} } },
        { emit: { kind: 'turn_end', ok: false, error: 'Claude AI usage limit reached' } }
      ]
    })
    const { engine } = await makeEngine(runtime)
    const a = await create(engine, 'A')
    await engine.invoke('agent.start', a.id)
    await waitFor(() => expect(runtime.specs).toHaveLength(1))

    await engine.invoke('orchestrator.send', 'What is going on?')

    await waitFor(async () => expect(await stateOf(engine, 'A')).toMatchObject({ agentStatus: 'paused', pausedByLimit: true }))
    expect(await engine.invoke('usage.get')).toMatchObject({ kind: 'limited', paused: 1 })
  })
})
