import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db/open'
import { createCleanupRepo } from './cleanups'
import { FIXED_NOW, openTestDb } from './testDb'

let db: Db
let cleanup: () => void

beforeEach(async () => {
  ;({ db, cleanup } = await openTestDb())
})
afterEach(() => cleanup())

describe('pending cleanup repo', () => {
  it('adds, lists in insertion order and marks cleanups done', async () => {
    const repo = createCleanupRepo(db, () => FIXED_NOW)
    await repo.add('t1', '/repo', '/work/r/1-a', 'mainbus/1-a')
    await repo.add('t2', '/repo', '/work/r/2-b', 'mainbus/2-b')

    expect(await repo.list()).toEqual([
      { ticketId: 't1', repoPath: '/repo', path: '/work/r/1-a', branch: 'mainbus/1-a' },
      { ticketId: 't2', repoPath: '/repo', path: '/work/r/2-b', branch: 'mainbus/2-b' }
    ])

    await repo.done('t1')
    expect((await repo.list()).map((c) => c.ticketId)).toEqual(['t2'])
  })

  it('adding the same ticket again replaces the row', async () => {
    const repo = createCleanupRepo(db, () => FIXED_NOW)
    await repo.add('t1', '/repo', '/old', 'b')
    await repo.add('t1', '/repo', '/new', 'b')
    expect(await repo.list()).toEqual([{ ticketId: 't1', repoPath: '/repo', path: '/new', branch: 'b' }])
  })

  it('marking an unknown ticket done is a no-op', async () => {
    await expect(createCleanupRepo(db, () => FIXED_NOW).done('missing')).resolves.toBeUndefined()
  })
})
