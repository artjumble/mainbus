import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createOrchestratorRepo, type OrchestratorRepo } from './orchestrator'
import { FIXED_NOW, openTestDb } from './testDb'

let cleanup: () => void
let repo: OrchestratorRepo

beforeEach(async () => {
  const testDb = await openTestDb()
  cleanup = testDb.cleanup
  repo = createOrchestratorRepo(testDb.db, () => FIXED_NOW)
})

afterEach(() => cleanup())

describe('orchestrator repo', () => {
  test('appends events with consecutive seq numbers per run', async () => {
    const a = await repo.create()
    const b = await repo.create()
    expect((await repo.append(a.id, { kind: 'user_message', text: 'hi' })).seq).toBe(1)
    expect((await repo.append(a.id, { kind: 'message', text: 'hello' })).seq).toBe(2)
    expect((await repo.append(b.id, { kind: 'notice', text: 'new' })).seq).toBe(1)
    expect(await repo.events(a.id)).toEqual([
      { runId: a.id, seq: 1, at: FIXED_NOW.toISOString(), event: { kind: 'user_message', text: 'hi' } },
      { runId: a.id, seq: 2, at: FIXED_NOW.toISOString(), event: { kind: 'message', text: 'hello' } }
    ])
  })

  test('latestOpen is the latest run while it is open, with its session', async () => {
    expect(await repo.latestOpen()).toBeNull()
    const a = await repo.create()
    await repo.setSession(a.id, 'sess-1')
    expect(await repo.latestOpen()).toMatchObject({ id: a.id, sessionId: 'sess-1', endReason: null })
    expect(await repo.end(a.id, 'resume_failed')).toBe(true)
    expect(await repo.latestOpen()).toBeNull()
    const b = await repo.create()
    expect((await repo.latestOpen())?.id).toBe(b.id)
    expect((await repo.list()).map((r) => [r.id, r.endReason])).toEqual([
      [a.id, 'resume_failed'],
      [b.id, null]
    ])
  })

  test('ends a run only once', async () => {
    const a = await repo.create()
    expect(await repo.end(a.id, 'resume_failed')).toBe(true)
    expect(await repo.end(a.id, 'resume_failed')).toBe(false)
  })
})
