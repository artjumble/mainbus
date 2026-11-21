import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { archiveCutoff } from '../archive/sweeper'
import type { Db } from '../db/open'
import { tickets } from '../db/schema'
import { createArchiveRepo } from './archive'
import { openTestDb } from './testDb'
import { createTicketRepo } from './tickets'
import { createWorkspaceRepo } from './workspaces'

let db: Db
let cleanup: () => void
let clock: Date
let wsId: string
const now = () => clock
const at = (iso: string) => {
  clock = new Date(iso)
}
const day = (n: number) => new Date(Date.UTC(2026, 10, n, 12)).toISOString()

beforeEach(async () => {
  ;({ db, cleanup } = await openTestDb())
  at(day(1))
  wsId = (await createWorkspaceRepo(db, now).create('/r', 'main', 'r', 'r')).id
})
afterEach(() => cleanup())

async function doneTicket(title: string, doneOn: string, workspaceId = wsId) {
  const repo = createTicketRepo(db, now)
  const t = await repo.create({ workspaceId, title, intent: title, spec: '', criteria: [], labels: [], column: 'ready' })
  const saved = clock
  at(doneOn)
  await repo.setManualColumn(t.id, 'done')
  clock = saved
  return t
}
const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!
const cutoff = (days: number) => archiveCutoff(clock, days)

describe('archive repo', () => {
  it('a sweep archives only Done tickets past the age; Backlog, Ready and young Done tickets stay', async () => {
    const tr = createTicketRepo(db, now)
    const old = await doneTicket('old', day(1))
    const young = await doneTicket('young', day(18))
    const ready = await tr.create({ workspaceId: wsId, title: 'r', intent: 'r', spec: '', criteria: [], labels: [], column: 'ready' })
    const backlog = await tr.create({ workspaceId: wsId, title: 'b', intent: 'b', spec: '', criteria: [], labels: [], column: 'backlog' })
    at(day(20))
    const repo = createArchiveRepo(db, now)

    const done = await repo.archiveOlder(wsId, { cutoff: cutoff(14), basis: 'sweep', olderThanDays: 14 })

    expect(done?.ticketIds).toEqual([old.id])
    expect(done?.batch).toMatchObject({ kind: 'sweep', olderThanDays: 14, count: 1 })
    expect((await row(old.id)).archivedAt).not.toBeNull()
    for (const t of [young, ready, backlog]) expect((await row(t.id)).archivedAt).toBeNull()
  })

  it('is idempotent: a second sweep archives nothing and makes no batch', async () => {
    await doneTicket('old', day(1))
    at(day(20))
    const repo = createArchiveRepo(db, now)
    const first = await repo.archiveOlder(wsId, { cutoff: cutoff(14), basis: 'sweep', olderThanDays: 14 })
    at(day(21))
    const second = await repo.archiveOlder(wsId, { cutoff: cutoff(14), basis: 'sweep', olderThanDays: 14 })

    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect((await repo.openNotice(wsId))?.id).toBe(first!.batch.id)
  })

  it('a restored ticket counts from its restore under a sweep, but from done_at under the bulk action', async () => {
    const t = await doneTicket('old', day(1))
    const tr = createTicketRepo(db, now)
    at(day(2))
    await tr.archive([t.id])
    at(day(20))
    await tr.unarchive([t.id])
    expect((await row(t.id)).restoredAt).toBe(day(20))
    at(day(30))
    const repo = createArchiveRepo(db, now)

    expect(await repo.countOlder(wsId, cutoff(14), 'sweep')).toBe(0)
    expect(await repo.countOlder(wsId, cutoff(14), 'bulk')).toBe(1)
    at(day(35))
    expect(await repo.countOlder(wsId, cutoff(14), 'sweep')).toBe(1)
  })

  it('countOlder agrees with archiveOlder', async () => {
    await doneTicket('a', day(1))
    await doneTicket('b', day(2))
    await doneTicket('c', day(25))
    at(day(30))
    const repo = createArchiveRepo(db, now)
    const n = await repo.countOlder(wsId, cutoff(14), 'bulk')
    const done = await repo.archiveOlder(wsId, { cutoff: cutoff(14), basis: 'bulk', olderThanDays: 14 })
    expect([n, done?.batch.count, done?.ticketIds.length]).toEqual([2, 2, 2])
  })

  it('a ticket whose done_at is unknown is never eligible', async () => {
    const t = await doneTicket('x', day(1))
    await db.update(tickets).set({ doneAt: null }).where(eq(tickets.id, t.id))
    at(day(30))
    expect(await createArchiveRepo(db, now).countOlder(wsId, cutoff(7), 'bulk')).toBe(0)
  })

  it('restoreBatch restores only its own batch: not another batch, not a hand-archived ticket, not one restored and archived again by hand', async () => {
    const tr = createTicketRepo(db, now)
    const repo = createArchiveRepo(db, now)
    const a = await doneTicket('a', day(1))
    const b = await doneTicket('b', day(1))
    const c = await doneTicket('c', day(1))
    at(day(10))
    const first = (await repo.archiveOlder(wsId, { cutoff: cutoff(7), basis: 'bulk', olderThanDays: 7 }))!
    expect([...first.ticketIds].sort()).toEqual([a.id, b.id, c.id].sort())
    // b is restored on its own, then archived again by hand: no longer part of the batch.
    await tr.unarchive([b.id])
    await tr.archive([b.id])
    const d = await doneTicket('d', day(2))
    const e = await doneTicket('e', day(3))
    await tr.archive([e.id])
    at(day(11))
    const second = (await repo.archiveOlder(wsId, { cutoff: cutoff(7), basis: 'bulk', olderThanDays: 7 }))!
    expect(second.ticketIds).toEqual([d.id])

    expect(await repo.restoreBatch(first.batch.id)).toBe(2)

    expect((await row(a.id)).archivedAt).toBeNull()
    expect((await row(c.id)).archivedAt).toBeNull()
    expect((await row(a.id)).restoredAt).toBe(day(11))
    for (const t of [b, d, e]) expect((await row(t.id)).archivedAt).not.toBeNull()
    expect(await repo.restoreBatch(first.batch.id)).toBe(0)
  })

  it('openNotice is the newest batch; a new batch closes the older notice; closing and restoring end a notice', async () => {
    const repo = createArchiveRepo(db, now)
    await doneTicket('a', day(1))
    at(day(10))
    const first = (await repo.archiveOlder(wsId, { cutoff: cutoff(7), basis: 'sweep', olderThanDays: 7 }))!
    expect((await repo.openNotice(wsId))?.id).toBe(first.batch.id)
    await doneTicket('b', day(10))
    at(day(20))
    const second = (await repo.archiveOlder(wsId, { cutoff: cutoff(7), basis: 'bulk', olderThanDays: 7 }))!
    expect((await repo.openNotice(wsId))?.id).toBe(second.batch.id)
    await repo.closeNotice(second.batch.id)
    expect(await repo.openNotice(wsId)).toBeNull()
    await repo.restoreBatch(first.batch.id)
    expect(await repo.openNotice(wsId)).toBeNull()
  })

  it('never touches another workspace', async () => {
    const other = (await createWorkspaceRepo(db, now).create('/o', 'main', 'o', 'o')).id
    const t = await doneTicket('o', day(1), other)
    at(day(30))
    expect(await createArchiveRepo(db, now).archiveOlder(wsId, { cutoff: cutoff(7), basis: 'sweep', olderThanDays: 7 })).toBeNull()
    expect((await row(t.id)).archivedAt).toBeNull()
  })
})
