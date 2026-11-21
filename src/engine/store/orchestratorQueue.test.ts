import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FIXED_NOW, openTestDb } from './testDb'
import { createOrchestratorQueueRepo, type OrchestratorQueueRepo } from './orchestratorQueue'

let cleanup: () => void
let repo: OrchestratorQueueRepo

beforeEach(async () => {
  const t = await openTestDb()
  cleanup = t.cleanup
  repo = createOrchestratorQueueRepo(t.db, () => FIXED_NOW)
})
afterEach(() => cleanup())

const add = (text: string, heldReason: string | null = null) => repo.add({ text, images: [], mentions: [], heldReason })

describe('the orchestrator queue store', () => {
  it('lists messages in the order they were added, with their images and mentions', async () => {
    await repo.add({ text: 'a', images: [{ id: 'i1', filename: 'x.png' }], mentions: ['w1'], heldReason: null })
    await add('b')
    const rows = await repo.list()
    expect(rows.map((r) => r.text)).toEqual(['a', 'b'])
    expect(rows[0]).toMatchObject({ images: [{ id: 'i1', filename: 'x.png' }], mentions: ['w1'], heldReason: null, queuedAt: FIXED_NOW.toISOString() })
  })

  it('edits the words, removes a message, and says so when it is gone', async () => {
    const a = await add('a')
    await add('b')
    expect(await repo.setText(a.id, 'a2')).toBe(true)
    expect((await repo.list())[0]!.text).toBe('a2')
    expect((await repo.remove(a.id))?.text).toBe('a2')
    expect(await repo.remove(a.id)).toBeNull()
    expect(await repo.setText(a.id, 'x')).toBe(false)
    expect(await repo.moveToFront(a.id)).toBe(false)
    expect((await repo.list()).map((r) => r.text)).toEqual(['b'])
  })

  it('moves a message to the front, and a later one still goes last', async () => {
    await add('a')
    await add('b')
    const c = await add('c')
    expect(await repo.moveToFront(c.id)).toBe(true)
    await add('d')
    expect((await repo.list()).map((r) => r.text)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('holds every message with a reason and releases them', async () => {
    await add('a')
    await add('b')
    await repo.holdAll('why')
    expect((await repo.list()).map((r) => r.heldReason)).toEqual(['why', 'why'])
    await repo.releaseAll()
    expect((await repo.list()).map((r) => r.heldReason)).toEqual([null, null])
  })
})
