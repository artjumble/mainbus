import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Ticket } from '../shared/domain'
import { runGit } from './git/git'
import { type HomePaths } from './home'
import { createEngine, type Engine } from './index'
import { makeRepo } from './intake/testBoard'
import { FakeRuntime, type FakeStep } from './runtime/fakeRuntime'
import type { ExecFn } from './runtime/resolveClaude'
import { eventually } from './testWait'
import { testHome } from './testFixtures'

// Each test starts an engine over a real repository: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

const migrationsDir = path.join(import.meta.dirname, 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })
const WORKING: FakeStep[] = [{ emit: { kind: 'session', sessionId: 'role-sess' } }, { waitForSend: true }]

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-reorder-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = await testHome(path.join(tmp, 'home'))
  engines = []
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function makeEngine(): Promise<Engine> {
  const engine = await createEngine({ paths, migrationsDir, runtime: new FakeRuntime(WORKING), git: runGit, exec })
  engines.push(engine)
  await engine.invoke('workspace.open', repoPath)
  return engine
}

const newTicket = (engine: Engine, title: string, column: 'backlog' | 'ready' = 'ready'): Promise<Ticket> =>
  engine.invoke('ticket.create', { title, intent: `Do ${title}`, spec: '', criteria: [], labels: [], column })

/** The titles in a column of the board, top first (the engine's own order for Backlog and Ready is by rank). */
async function order(engine: Engine, column: string): Promise<string[]> {
  const { tickets } = await engine.invoke('board.get')
  return tickets
    .filter((t) => t.state.column === column)
    .sort((a, b) => a.rank - b.rank || a.number - b.number)
    .map((t) => t.title)
}

describe('ticket.reorder', () => {
  test('new tickets go to the bottom, and a reorder persists across a restart', async () => {
    const engine = await makeEngine()
    const [a, b, c] = [await newTicket(engine, 'A'), await newTicket(engine, 'B'), await newTicket(engine, 'C')]
    expect(await order(engine, 'ready')).toEqual(['A', 'B', 'C'])

    await engine.invoke('ticket.reorder', c!.id, a!.id)
    expect(await order(engine, 'ready')).toEqual(['C', 'A', 'B'])
    await engine.invoke('ticket.reorder', c!.id, null)
    expect(await order(engine, 'ready')).toEqual(['A', 'B', 'C'])
    await engine.invoke('ticket.reorder', b!.id, a!.id)
    expect(await order(engine, 'ready')).toEqual(['B', 'A', 'C'])

    await engine.dispose()
    engines = []
    const again = await createEngine({ paths, migrationsDir, runtime: new FakeRuntime(WORKING), git: runGit, exec })
    engines.push(again)
    await again.invoke('workspace.open', repoPath)
    expect(await order(again, 'ready')).toEqual(['B', 'A', 'C'])
  })

  test('keeps the order after many moves to the same spot (ranks that would tie are renumbered)', async () => {
    const engine = await makeEngine()
    const a = await newTicket(engine, 'A')
    const x = await newTicket(engine, 'X')
    const y = await newTicket(engine, 'Y')
    // Each move puts the ticket between A and the previous one, halving the gap every time.
    let before = x.id
    for (let i = 0; i < 60; i++) {
      const moving = i % 2 === 0 ? y : a
      await engine.invoke('ticket.reorder', moving.id, before)
      before = moving.id
    }
    const titles = await order(engine, 'ready')
    expect(titles).toHaveLength(3)
    expect(new Set(titles).size).toBe(3)
  })

  test('refuses a ticket outside Backlog and Ready, and a ticket in another column', async () => {
    const engine = await makeEngine()
    const a = await newTicket(engine, 'A')
    const b = await newTicket(engine, 'B', 'backlog')
    await expect(engine.invoke('ticket.reorder', a.id, b.id)).rejects.toThrow("That ticket isn't in Ready any more")
    await engine.invoke('ticket.move', a.id, 'done')
    await expect(engine.invoke('ticket.reorder', a.id, null)).rejects.toThrow('only Backlog and Ready can be reordered')
    await expect(engine.invoke('ticket.reorder', b.id, 5 as unknown as string)).rejects.toThrow('before must be')
  })

  test('refuses a ticket with an agent working on it (In progress)', async () => {
    const engine = await makeEngine()
    const a = await newTicket(engine, 'A')
    await engine.invoke('agent.start', a.id)
    await expect(engine.invoke('ticket.reorder', a.id, null)).rejects.toThrow('is in In progress')
  })
})

describe('ticket.move with a place', () => {
  test('lands just above the ticket given, or at the bottom with none', async () => {
    const engine = await makeEngine()
    const a = await newTicket(engine, 'A')
    const b = await newTicket(engine, 'B')
    const c = await newTicket(engine, 'C', 'backlog')
    await engine.invoke('ticket.move', c.id, 'ready', b.id)
    expect(await order(engine, 'ready')).toEqual(['A', 'C', 'B'])
    await engine.invoke('ticket.move', c.id, 'backlog')
    await engine.invoke('ticket.move', c.id, 'ready')
    expect(await order(engine, 'ready')).toEqual(['A', 'B', 'C'])
    // A ticket that isn't in the target column can't be the place.
    await expect(engine.invoke('ticket.move', c.id, 'backlog', a.id)).rejects.toThrow()
  })
})

describe('list_tickets', () => {
  test('lists Ready in the board order under a heading that says so', async () => {
    const runtime = new FakeRuntime(WORKING, { orchestrator: [{ emit: { kind: 'session', sessionId: 'o' } }, { waitForSend: true }] })
    const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec })
    engines.push(engine)
    await engine.invoke('workspace.open', repoPath)
    const a = await newTicket(engine, 'A')
    await newTicket(engine, 'B')
    const c = await newTicket(engine, 'C')
    await engine.invoke('ticket.reorder', c.id, a.id)
    await engine.invoke('orchestrator.send', 'Hello')
    await eventually(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    const out = await runtime.orchestratorSpecs[0]!.tools.listTickets({})
    expect(out).toContain('Ready, in order (top first; unattended mode starts from the top):')
    const titles = [...out.matchAll(/field="title">(\w)</g)].map((m) => m[1])
    expect(titles).toEqual(['C', 'A', 'B'])
  })
})
