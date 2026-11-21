import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { ArchiveBatch } from '../../shared/domain'
import type { Db } from '../db/open'
import { archiveBatches, tickets } from '../db/schema'

/** What "older than" counts from: a sweep from the later of reaching Done and the last restore; the bulk action from reaching Done. */
export type ArchiveBasis = 'sweep' | 'bulk'

export interface ArchiveRepo {
  /** How many of the workspace's Done, unarchived tickets are older than the cutoff (an ISO time, strictly before). */
  countOlder(workspaceId: string, cutoff: string, basis: ArchiveBasis): Promise<number>
  /**
   * Archives those tickets as one batch and returns it with their ids; null (and no batch) when there are none, which is
   * what makes a sweep idempotent. A new batch closes the workspace's earlier open notice.
   */
  archiveOlder(
    workspaceId: string,
    opts: { cutoff: string; basis: ArchiveBasis; olderThanDays: number }
  ): Promise<{ batch: ArchiveBatch; ticketIds: string[] } | null>
  /** Restores the tickets the batch archived and only those (a fresh window for the sweep), and closes its notice. Returns how many came back. */
  restoreBatch(batchId: string): Promise<number>
  /** The batch with this id; null when unknown. */
  batch(batchId: string): Promise<ArchiveBatch | null>
  /** The workspace's newest batch whose notice is still open; null when none. */
  openNotice(workspaceId: string): Promise<ArchiveBatch | null>
  closeNotice(batchId: string): Promise<void>
}

function toBatch(row: typeof archiveBatches.$inferSelect): ArchiveBatch {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind === 'bulk' ? 'bulk' : 'sweep',
    olderThanDays: row.olderThanDays,
    count: row.count,
    createdAt: row.createdAt
  }
}

export function createArchiveRepo(db: Db, now: () => Date): ArchiveRepo {
  /** The Done tickets older than the cutoff. A null done_at (a ticket we can't date) is never eligible. */
  function candidates(workspaceId: string, cutoff: string, basis: ArchiveBasis) {
    const age = basis === 'sweep' ? sql`max(${tickets.doneAt}, coalesce(${tickets.restoredAt}, ${tickets.doneAt}))` : sql`${tickets.doneAt}`
    return and(
      eq(tickets.workspaceId, workspaceId),
      eq(tickets.manualColumn, 'done'),
      isNull(tickets.archivedAt),
      isNotNull(tickets.doneAt),
      sql`${age} < ${cutoff}`
    )
  }

  async function openNotice(workspaceId: string): Promise<ArchiveBatch | null> {
    const [row] = await db
      .select()
      .from(archiveBatches)
      .where(and(eq(archiveBatches.workspaceId, workspaceId), isNull(archiveBatches.noticeClosedAt)))
      .orderBy(desc(archiveBatches.createdAt), desc(sql`rowid`))
      .limit(1)
    return row ? toBatch(row) : null
  }

  return {
    async countOlder(workspaceId, cutoff, basis) {
      const [row] = await db
        .select({ n: sql<number>`count(*)` })
        .from(tickets)
        .where(candidates(workspaceId, cutoff, basis))
      return Number(row?.n ?? 0)
    },

    async archiveOlder(workspaceId, { cutoff, basis, olderThanDays }) {
      const ids = (await db.select({ id: tickets.id }).from(tickets).where(candidates(workspaceId, cutoff, basis))).map((r) => r.id)
      if (ids.length === 0) return null
      const at = now().toISOString()
      const id = randomUUID()
      // The conditions are repeated in the update: a ticket moved or archived between the select and here is left alone.
      await db.batch([
        db.update(archiveBatches).set({ noticeClosedAt: at }).where(and(eq(archiveBatches.workspaceId, workspaceId), isNull(archiveBatches.noticeClosedAt))),
        db.insert(archiveBatches).values({ id, workspaceId, kind: basis, olderThanDays, count: ids.length, createdAt: at }),
        db
          .update(tickets)
          .set({ archivedAt: at, archiveBatchId: id })
          .where(and(inArray(tickets.id, ids), eq(tickets.manualColumn, 'done'), isNull(tickets.archivedAt)))
      ])
      const archived = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.archiveBatchId, id))
      if (archived.length !== ids.length) await db.update(archiveBatches).set({ count: archived.length }).where(eq(archiveBatches.id, id))
      const [row] = await db.select().from(archiveBatches).where(eq(archiveBatches.id, id))
      return { batch: toBatch(row!), ticketIds: archived.map((r) => r.id) }
    },

    async restoreBatch(batchId) {
      const at = now().toISOString()
      const mine = and(eq(tickets.archiveBatchId, batchId), isNotNull(tickets.archivedAt))
      const [row] = await db.select({ n: sql<number>`count(*)` }).from(tickets).where(mine)
      await db.batch([
        db.update(tickets).set({ archivedAt: null, archiveBatchId: null, restoredAt: at }).where(mine),
        db.update(archiveBatches).set({ restoredAt: at, noticeClosedAt: at }).where(and(eq(archiveBatches.id, batchId), isNull(archiveBatches.restoredAt)))
      ])
      return Number(row?.n ?? 0)
    },

    async batch(batchId) {
      const [row] = await db.select().from(archiveBatches).where(eq(archiveBatches.id, batchId))
      return row ? toBatch(row) : null
    },

    openNotice,

    async closeNotice(batchId) {
      await db
        .update(archiveBatches)
        .set({ noticeClosedAt: now().toISOString() })
        .where(and(eq(archiveBatches.id, batchId), isNull(archiveBatches.noticeClosedAt)))
    }
  }
}
