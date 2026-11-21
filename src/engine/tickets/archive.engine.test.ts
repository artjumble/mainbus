import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { EngineEvent } from '../../shared/api'
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

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-archive-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = await testHome(path.join(tmp, 'home'))
  engines = []
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const HANDING_OFF: FakeStep[] = [
  { emit: { kind: 'session', sessionId: 'role-sess' } },
  { emit: { kind: 'usage', inputTokens: 1500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, models: {}, costUsd: 0.5, durationMs: 60_000 } },
  { callTool: 'handoff', args: { summary: 'Did the work', notesForNext: 'nothing' } },
  { emit: { kind: 'turn_end', ok: true } }
]
const OPEN_TURN: FakeStep[] = [{ emit: { kind: 'session', sessionId: 'orch' } }, { waitForSend: true }]

async function makeEngine() {
  const runtime = new FakeRuntime(HANDING_OFF, { orchestrator: OPEN_TURN })
  // A clock that never advances, so the done-review wake never fires.
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec, clock: new FakeClock(new Date('2026-11-02T09:00:00.000Z')) })
  engines.push(engine)
  await engine.invoke('workspace.open', repoPath)
  await engine.invoke('orchestrator.send', 'Hello')
  await eventually(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
  return { engine, tools: runtime.orchestratorSpecs[0]!.tools }
}

type TestEngine = Engine
const newTicket = (engine: TestEngine, title: string, column: 'ready' | 'backlog' = 'ready', blockedBy?: string[]) =>
  engine.invoke('ticket.create', { title, intent: `Do ${title}`, spec: '', criteria: [], labels: [], column, ...(blockedBy ? { blockedBy } : {}) })
const board = async (engine: TestEngine) => (await engine.invoke('board.get')).tickets
const ticketOf = async (engine: TestEngine, id: string) => (await board(engine)).find((t) => t.id === id)

/** A ticket whose roles ran and handed off, then moved to Done. */
async function done(engine: TestEngine, title: string) {
  const ticket = await newTicket(engine, title)
  await engine.invoke('agent.start', ticket.id)
  await eventually(async () => expect((await ticketOf(engine, ticket.id))!.state.column).toBe('review'))
  expect(await engine.invoke('ticket.move', ticket.id, 'done')).toBe('moved')
  return ticket
}

describe('archiving a Done ticket', () => {
  test('leaves the board and list_tickets, but get_ticket, get_run_status, get_recent_events and the Time report still answer', async () => {
    const { engine, tools } = await makeEngine()
    const t = await done(engine, 'Login')
    const n = t.number
    expect(await tools.listTickets({})).toContain('Login')

    await engine.invoke('ticket.archive', [t.id])

    expect(await ticketOf(engine, t.id)).toBeUndefined()
    expect(await tools.listTickets({})).not.toContain('Login')
    for (const text of [await tools.getTicket({ number: n }), await tools.getRunStatus({ number: n }), await tools.getRecentEvents({ number: n }), await tools.getTimeReport({ ticket: n })]) {
      expect(text).not.toContain(`No ticket #${n}`)
    }
    expect(await tools.getTicket({ number: n })).toContain('Login')
  })

  test('the Time report, usage and the ticket view are identical before and after', async () => {
    const { engine, tools } = await makeEngine()
    const t = await done(engine, 'Login')
    const before = {
      time: await engine.invoke('ticket.time', t.id),
      ticketReport: await tools.getTimeReport({ ticket: t.number }),
      workspaceReport: await tools.getTimeReport({}),
      view: await tools.getTicket({ number: t.number })
    }
    expect(before.view).toContain('## Usage')
    await engine.invoke('ticket.archive', [t.id])
    expect({
      time: await engine.invoke('ticket.time', t.id),
      ticketReport: await tools.getTimeReport({ ticket: t.number }),
      workspaceReport: await tools.getTimeReport({}),
      view: await tools.getTicket({ number: t.number })
    }).toEqual(before)
  })

  test('a ticket blocked by an archived ticket still sees it as Done', async () => {
    const { engine } = await makeEngine()
    const a = await done(engine, 'First')
    const b = await newTicket(engine, 'Second', 'backlog', [a.id])
    expect((await ticketOf(engine, b.id))!.blockedBy).toEqual([{ id: a.id, number: a.number, title: 'First', done: true }])
    await engine.invoke('ticket.archive', [a.id])
    expect((await ticketOf(engine, b.id))!.blockedBy).toEqual([{ id: a.id, number: a.number, title: 'First', done: true }])
  })

  test('only Done tickets can be archived; nothing is archived when one is refused', async () => {
    const { engine, tools } = await makeEngine()
    const d = await done(engine, 'Finished')
    const r = await newTicket(engine, 'Waiting')
    await expect(engine.invoke('ticket.archive', [d.id, r.id])).rejects.toThrow(/Only Done tickets can be archived/)
    expect(await ticketOf(engine, d.id)).toBeDefined()
    expect(await tools.listTickets({})).toContain('Finished')
  })

  test('unarchive puts it back on the board in Done; both commands emit board.changed', async () => {
    const { engine } = await makeEngine()
    const t = await done(engine, 'Login')
    const events: EngineEvent[] = []
    engine.on((e) => events.push(e))
    const changed = () => events.filter((e) => e.type === 'board.changed').length
    // Other activity may emit board.changed too, so look at what each command adds.
    let seen = changed()
    await engine.invoke('ticket.archive', [t.id])
    expect(changed()).toBeGreaterThan(seen)
    seen = changed()
    await engine.invoke('ticket.unarchive', [t.id])
    expect(changed()).toBeGreaterThan(seen)
    const back = await ticketOf(engine, t.id)
    expect(back!.manualColumn).toBe('done')
    expect(back!.state.column).toBe('done')
  })
})
