import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Db } from '../db/open'
import { createHoldRepo, type HoldRepo } from './holds'
import { FIXED_NOW, openTestDb } from './testDb'

let db: Db
let cleanup: () => void
let repo: HoldRepo
let clock: Date

const at = (minutes: number) => new Date(FIXED_NOW.getTime() + minutes * 60_000).toISOString()

beforeEach(async () => {
  ;({ db, cleanup } = await openTestDb())
  clock = FIXED_NOW
  repo = createHoldRepo(db, () => clock)
})

afterEach(() => cleanup())

describe('hold repo', () => {
  test('places a hold on a ticket, with or without a date and reason', async () => {
    const plain = await repo.place('ticket', 't1', {})
    expect(plain).toEqual({
      id: plain.id,
      targetKind: 'ticket',
      targetId: 't1',
      reason: null,
      until: null,
      createdBy: 'user',
      createdAt: FIXED_NOW.toISOString(),
      releasedAt: null
    })
    const dated = await repo.place('ticket', 't2', { until: at(60), reason: '  Waiting for the API  ' })
    expect(dated).toMatchObject({ until: at(60), reason: 'Waiting for the API' })
    expect(await repo.active('ticket', 't1')).toEqual(plain)
    expect(await repo.active('ticket', 'nobody')).toBeNull()
  })

  test('a target has at most one unreleased hold: placing again changes it', async () => {
    const first = await repo.place('ticket', 't1', { until: at(60), reason: 'Wait' })
    const again = await repo.place('ticket', 't1', {})
    expect(again).toMatchObject({ id: first.id, until: null, reason: null })
    expect(await repo.activeOf('ticket')).toHaveLength(1)
  })

  test('the database itself refuses a second unreleased hold on a target, of either kind', async () => {
    await repo.place('ticket', 't1', {})
    const insert = (kind: string, target: string) =>
      db.run(
        sql`insert into holds (id, target_kind, target_id, created_by, created_at) values (${crypto.randomUUID()}, ${kind}, ${target}, 'user', 'x')`
      )
    await expect(insert('ticket', 't1')).rejects.toThrow()
    // Another target, or the same id as another kind of target, is fine.
    await insert('ticket', 't2')
    await insert('decision', 't1')
    await expect(insert('decision', 't1')).rejects.toThrow()
  })

  test('a released hold can be placed again, as a new one', async () => {
    const first = await repo.place('ticket', 't1', {})
    clock = new Date(at(5))
    expect(await repo.release('ticket', 't1')).toMatchObject({ id: first.id, releasedAt: at(5) })
    expect(await repo.active('ticket', 't1')).toBeNull()
    expect(await repo.release('ticket', 't1')).toBeNull()
    const second = await repo.place('ticket', 't1', {})
    expect(second.id).not.toBe(first.id)
    expect(await repo.activeOf('ticket')).toEqual([second])
  })

  test('holds on tickets and on decisions are kept apart', async () => {
    await repo.place('ticket', 'x', {})
    await repo.place('decision', 'x', {})
    expect(await repo.activeOf('ticket')).toHaveLength(1)
    expect(await repo.release('decision', 'x')).toMatchObject({ targetKind: 'decision' })
    expect(await repo.active('ticket', 'x')).not.toBeNull()
  })

  test('releaseDue releases the holds whose date is at or before the time, earliest first, and none without a date', async () => {
    await repo.place('ticket', 'late', { until: at(30) })
    await repo.place('ticket', 'early', { until: at(10) })
    await repo.place('ticket', 'none', {})
    await repo.place('ticket', 'future', { until: at(90) })
    clock = new Date(at(45))
    const released = await repo.releaseDue(clock)
    expect(released.map((h) => h.targetId)).toEqual(['early', 'late'])
    expect(released.every((h) => h.releasedAt === at(45))).toBe(true)
    expect((await repo.activeOf('ticket')).map((h) => h.targetId).sort()).toEqual(['future', 'none'])
    expect(await repo.releaseDue(clock)).toEqual([])
  })

  test('nextDue is the earliest date among the unreleased holds', async () => {
    expect(await repo.nextDue()).toBeNull()
    await repo.place('ticket', 'none', {})
    expect(await repo.nextDue()).toBeNull()
    await repo.place('ticket', 'b', { until: at(50) })
    await repo.place('ticket', 'a', { until: at(20) })
    expect(await repo.nextDue()).toBe(at(20))
    await repo.release('ticket', 'a')
    expect(await repo.nextDue()).toBe(at(50))
  })

  test('releasedSince lists the released holds at or after the time, oldest release first', async () => {
    await repo.place('ticket', 'a', {})
    await repo.place('ticket', 'b', {})
    await repo.place('ticket', 'c', {})
    clock = new Date(at(5))
    await repo.release('ticket', 'a')
    clock = new Date(at(10))
    await repo.release('ticket', 'b')
    expect((await repo.releasedSince('ticket', null)).map((h) => h.targetId)).toEqual(['a', 'b'])
    expect((await repo.releasedSince('ticket', at(10))).map((h) => h.targetId)).toEqual(['b'])
    expect(await repo.releasedSince('ticket', at(11))).toEqual([])
    expect(await repo.releasedSince('decision', null)).toEqual([])
  })
})
