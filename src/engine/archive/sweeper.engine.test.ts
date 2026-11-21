import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runGit } from '../git/git'
import { FakeClock, type Clock } from '../holds/clock'
import { type HomePaths } from '../home'
import { createEngine, type Engine } from '../index'
import { makeRepo } from '../intake/testBoard'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import type { ExecFn } from '../runtime/resolveClaude'
import { eventually } from '../testWait'
import { testHome } from '../testFixtures'

// Each test starts an engine over a real repository: allow for a loaded machine.
vi.setConfig({ testTimeout: 60_000 })

const DAY = 86_400_000
const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]
/** The engine's time: it moves only when a test says so, and no engine timer ever fires from it. */
let time: number
const clock: Clock = { now: () => new Date(time), setTimeout: () => 0, clearTimeout: () => {} }
/** The sweep's own timer: a FakeClock, so advancing it by a day runs the daily sweep. */
let sweepTimer: FakeClock

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-sweep-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = await testHome(path.join(tmp, 'home'))
  engines = []
  time = Date.parse('2026-11-02T09:00:00.000Z')
  sweepTimer = new FakeClock(new Date(time))
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const HANDING_OFF: FakeStep[] = [
  { emit: { kind: 'session', sessionId: 'role-sess' } },
  { callTool: 'handoff', args: { summary: 'Did the work', notesForNext: 'nothing' } },
  { emit: { kind: 'turn_end', ok: true } }
]

async function makeEngine() {
  const runtime = new FakeRuntime(HANDING_OFF)
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec, clock, archive: { timer: sweepTimer } })
  engines.push(engine)
  return engine
}

/** Days pass: the engine's time moves a day, then the sweep's daily timer fires. */
async function pass(days: number) {
  for (let i = 0; i < days; i++) {
    time += DAY
    await sweepTimer.advance(DAY)
  }
}

const board = async (engine: Engine) => (await engine.invoke('board.get')).tickets
const onBoard = async (engine: Engine) => (await board(engine)).map((t) => t.number).sort((a, b) => a - b)

async function doneTicket(engine: Engine, title: string) {
  const ticket = await engine.invoke('ticket.create', { title, intent: `Do ${title}`, spec: '', criteria: [], labels: [], column: 'ready' })
  await engine.invoke('agent.start', ticket.id)
  await eventually(async () => expect((await board(engine)).find((t) => t.id === ticket.id)!.state.column).toBe('review'))
  expect(await engine.invoke('ticket.move', ticket.id, 'done')).toBe('moved')
  return ticket
}

describe('automatic archiving', () => {
  test('is Off by default: nothing is archived however many days pass', async () => {
    const engine = await makeEngine()
    await engine.invoke('workspace.open', repoPath)
    const a = await doneTicket(engine, 'A')
    await pass(100)
    expect(await onBoard(engine)).toEqual([a.number])
    expect((await engine.invoke('board.get')).archiveNotice).toBeNull()
  })

  test('the setting is per workspace and survives a restart; a sweep at start-up archives what has aged', async () => {
    const engine = await makeEngine()
    const ws = await engine.invoke('workspace.open', repoPath)
    const other = await engine.invoke('workspace.open', await makeRepo(path.join(tmp, 'other')))
    await engine.invoke('workspace.focus', ws.id)
    const old = await doneTicket(engine, 'Old')
    await engine.invoke('workspace.setAutoArchiveDays', 14, ws.id)
    expect((await engine.invoke('workspace.list')).map((w) => w.autoArchiveDays)).toEqual([14, null])
    expect(other.autoArchiveDays).toBeNull()
    await engine.dispose()
    engines.pop()

    time += 20 * DAY
    const again = await makeEngine()
    expect((await again.invoke('workspace.list')).map((w) => w.autoArchiveDays)).toEqual([14, null])
    await again.invoke('workspace.focus', ws.id)
    expect(await onBoard(again)).not.toContain(old.number)
    expect((await again.invoke('board.get')).archived).toBe(1)
  })

  test('the daily sweep archives only Done tickets past the age, never other columns, and is idempotent', async () => {
    const engine = await makeEngine()
    const ws = await engine.invoke('workspace.open', repoPath)
    const old = await doneTicket(engine, 'Old')
    await pass(10)
    const newer = await doneTicket(engine, 'Newer')
    const ready = await engine.invoke('ticket.create', { title: 'R', intent: 'r', spec: '', criteria: [], labels: [], column: 'ready' })
    const backlog = await engine.invoke('ticket.create', { title: 'B', intent: 'b', spec: '', criteria: [], labels: [], column: 'backlog' })
    await engine.invoke('workspace.setAutoArchiveDays', 14, ws.id)
    expect(await onBoard(engine)).toEqual([old.number, newer.number, ready.number, backlog.number])

    await pass(5) // Old is 15 days in Done; Newer 5.
    expect(await onBoard(engine)).toEqual([newer.number, ready.number, backlog.number])
    const notice = (await engine.invoke('board.get')).archiveNotice
    expect(notice).toMatchObject({ kind: 'sweep', olderThanDays: 14, count: 1 })

    await pass(3) // Nothing new has aged: no new batch, the same notice.
    expect(await onBoard(engine)).toEqual([newer.number, ready.number, backlog.number])
    expect((await engine.invoke('board.get')).archiveNotice).toEqual(notice)

    await pass(20) // Newer ages out; Ready and Backlog never do.
    expect(await onBoard(engine)).toEqual([ready.number, backlog.number])
    expect((await engine.invoke('board.get')).archiveNotice).toMatchObject({ count: 1 })
    expect((await engine.invoke('board.get')).archiveNotice?.id).not.toBe(notice!.id)
  })

  test('a restored ticket gets a fresh window: it stays on the board for N days from the restore', async () => {
    const engine = await makeEngine()
    const ws = await engine.invoke('workspace.open', repoPath)
    const t = await doneTicket(engine, 'Old')
    await pass(20)
    await engine.invoke('workspace.setAutoArchiveDays', 14, ws.id)
    expect(await onBoard(engine)).toEqual([])
    await engine.invoke('ticket.unarchive', [t.id])
    expect(await onBoard(engine)).toEqual([t.number])

    await pass(13)
    expect(await onBoard(engine)).toEqual([t.number])
    await pass(2)
    expect(await onBoard(engine)).toEqual([])
  })

  test('choosing a setting sweeps at once; Off stops it', async () => {
    const engine = await makeEngine()
    const ws = await engine.invoke('workspace.open', repoPath)
    await doneTicket(engine, 'Old')
    time += 40 * DAY
    await engine.invoke('workspace.setAutoArchiveDays', 30, ws.id)
    expect(await onBoard(engine)).toEqual([])
    await engine.invoke('workspace.setAutoArchiveDays', null, ws.id)
    await expect(engine.invoke('workspace.setAutoArchiveDays', 5 as never, ws.id)).rejects.toThrow()
    const second = await doneTicket(engine, 'Second')
    await pass(100)
    expect(await onBoard(engine)).toEqual([second.number])
  })
})

describe('the bulk "Archive Done older than…" action and Restore all', () => {
  test('counts first, archives the same number as one batch, and Restore all undoes only that batch', async () => {
    const engine = await makeEngine()
    const ws = await engine.invoke('workspace.open', repoPath)
    const a = await doneTicket(engine, 'A')
    const b = await doneTicket(engine, 'B')
    await pass(10)
    const c = await doneTicket(engine, 'C')
    const hand = await doneTicket(engine, 'Hand')
    await engine.invoke('ticket.archive', [hand.id])
    await pass(10)

    expect(await engine.invoke('archive.countOlder', 14, ws.id)).toBe(2)
    expect(await engine.invoke('archive.countOlder', 30, ws.id)).toBe(0)
    expect(await engine.invoke('archive.olderThan', 30, ws.id)).toBeNull()
    const batch = (await engine.invoke('archive.olderThan', 14, ws.id))!
    expect(batch).toMatchObject({ kind: 'bulk', olderThanDays: 14, count: 2 })
    expect(await onBoard(engine)).toEqual([c.number])
    expect((await engine.invoke('board.get')).archiveNotice?.id).toBe(batch.id)
    expect(await engine.invoke('archive.countOlder', 14, ws.id)).toBe(0)

    expect(await engine.invoke('archive.restoreBatch', batch.id)).toBe(2)
    expect(await onBoard(engine)).toEqual([a.number, b.number, c.number])
    expect((await engine.invoke('board.get')).archiveNotice).toBeNull()
    expect((await engine.invoke('board.get')).archived).toBe(1)
  })

  test('closing the notice leaves the tickets archived and the notice gone for good', async () => {
    const engine = await makeEngine()
    const ws = await engine.invoke('workspace.open', repoPath)
    await doneTicket(engine, 'A')
    await pass(10)
    const batch = (await engine.invoke('archive.olderThan', 7, ws.id))!
    await engine.invoke('archive.closeNotice', batch.id)
    const got = await engine.invoke('board.get')
    expect(got.archiveNotice).toBeNull()
    expect(got.archived).toBe(1)
  })
})
