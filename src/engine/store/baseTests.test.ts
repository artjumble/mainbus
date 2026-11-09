import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db/open'
import { BASE_TEST_RUNS_KEPT, createBaseTestRepo, type BaseTestRun } from './baseTests'
import { FIXED_NOW, openTestDb } from './testDb'
import { createWorkspaceRepo } from './workspaces'

let db: Db
let cleanup: () => void

beforeEach(async () => {
  ;({ db, cleanup } = await openTestDb())
})
afterEach(() => cleanup())

function run(workspaceId: string, i: number, extra: Partial<BaseTestRun> = {}): Omit<BaseTestRun, 'id'> {
  return {
    workspaceId,
    baseRef: 'origin/main',
    baseSha: `sha${i}`,
    trigger: 'base_moved',
    startedAt: new Date(Date.UTC(2026, 10, 1, 10, i)).toISOString(),
    endedAt: new Date(Date.UTC(2026, 10, 1, 10, i, 30)).toISOString(),
    error: null,
    results: [{ name: 'Unit', command: 'x', format: 'plain', exitCode: 1, timedOut: false, durationMs: 5, failures: [], tail: ['t'], note: null }],
    ...extra
  }
}

describe('base test run repo', () => {
  it('keeps only the newest 10 runs of a workspace, and not another workspace’s', async () => {
    const workspaces = createWorkspaceRepo(db, () => FIXED_NOW)
    const a = await workspaces.create('/a', 'main', 'a', 'a')
    const b = await workspaces.create('/b', 'main', 'b', 'b')
    const repo = createBaseTestRepo(db)
    await repo.add(run(b.id, 0))
    for (let i = 0; i < 13; i++) await repo.add(run(a.id, i))

    const kept = await repo.list(a.id)
    expect(kept).toHaveLength(BASE_TEST_RUNS_KEPT)
    expect(kept.map((r) => r.baseSha)).toEqual(Array.from({ length: 10 }, (_, k) => `sha${12 - k}`))
    expect(await repo.list(b.id)).toHaveLength(1)
    expect((await repo.latest(a.id))?.baseSha).toBe('sha12')
  })

  it('stores the results and the error as given, and has no latest run before one', async () => {
    const workspaces = createWorkspaceRepo(db, () => FIXED_NOW)
    const ws = await workspaces.create('/a', 'main', 'a', 'a')
    const repo = createBaseTestRepo(db)
    expect(await repo.latest(ws.id)).toBeNull()
    await repo.add(run(ws.id, 1, { error: 'setup failed', results: [] }))
    expect(await repo.latest(ws.id)).toMatchObject({ error: 'setup failed', results: [], trigger: 'base_moved' })
  })

  it('stores test commands on the workspace, trimmed, and refuses a bad list without saving', async () => {
    const workspaces = createWorkspaceRepo(db, () => FIXED_NOW)
    const ws = await workspaces.create('/a', 'main', 'a', 'a')
    const saved = await workspaces.setTestCommands(ws.id, [{ name: ' Unit ', command: ' npx vitest --outputFile=<results> ', format: 'vitest-json' }])
    expect(saved.testCommands).toEqual([{ name: 'Unit', command: 'npx vitest --outputFile=<results>', format: 'vitest-json' }])
    expect((await workspaces.get(ws.id))!.testCommands).toEqual(saved.testCommands)

    await expect(workspaces.setTestCommands(ws.id, [{ name: 'X', command: 'no placeholder', format: 'junit-xml' }])).rejects.toThrow('<results>')
    expect((await workspaces.get(ws.id))!.testCommands).toEqual(saved.testCommands)
    expect((await workspaces.setTestCommands(ws.id, [])).testCommands).toEqual([])
  })
})
