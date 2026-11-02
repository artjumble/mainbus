import { randomUUID } from 'node:crypto'
import { and, asc, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import type { Hold, HoldOptions, HoldTarget } from '../../shared/domain'
import type { Db } from '../db/open'
import { decisions, holds } from '../db/schema'

export interface HoldRepo {
  /** Holds the target; one that is already held keeps its hold, with the new date and reason. */
  place(kind: HoldTarget, targetId: string, opts: HoldOptions): Promise<Hold>
  /** Releases the target's hold (a decision's goes back to pending); null when it had none. */
  release(kind: HoldTarget, targetId: string): Promise<Hold | null>
  /** The target's unreleased hold, or null. */
  active(kind: HoldTarget, targetId: string): Promise<Hold | null>
  /** Every unreleased hold on this kind of target. */
  activeOf(kind: HoldTarget): Promise<Hold[]>
  /** Releases every hold whose date is at or before `at`, returning deferred decisions to pending; returns them, earliest first. */
  releaseDue(at: Date): Promise<Hold[]>
  /** The hold with this id, released or not; null when there is none. */
  get(id: string): Promise<Hold | null>
  /** The earliest date of an unreleased hold, or null when none has one. */
  nextDue(): Promise<string | null>
  /** Returns to pending every deferred decision with no hold left on it (one left over from a crash); true when it changed any. */
  reconcileDecisions(): Promise<boolean>
  /** The holds on this kind of target released at or after `since` (every released one when null), oldest release first. */
  releasedSince(kind: HoldTarget, since: string | null): Promise<Hold[]>
}

function toHold(row: typeof holds.$inferSelect): Hold {
  return {
    id: row.id,
    targetKind: row.targetKind,
    targetId: row.targetId,
    reason: row.reason,
    until: row.until,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    releasedAt: row.releasedAt
  }
}

export function createHoldRepo(db: Db, now: () => Date): HoldRepo {
  /** A deferred decision whose hold is gone is pending again; run in the same batch as every release. */
  const reconcile = () =>
    db
      .update(decisions)
      .set({ status: 'pending' })
      .where(
        and(
          eq(decisions.status, 'deferred'),
          sql`not exists (select 1 from ${holds} where ${holds.targetKind} = 'decision' and ${holds.targetId} = ${decisions.id} and ${holds.releasedAt} is null)`
        )
      )

  const unreleased = (kind: HoldTarget, targetId: string) =>
    and(eq(holds.targetKind, kind), eq(holds.targetId, targetId), isNull(holds.releasedAt))

  async function active(kind: HoldTarget, targetId: string): Promise<Hold | null> {
    const [row] = await db.select().from(holds).where(unreleased(kind, targetId))
    return row ? toHold(row) : null
  }

  return {
    async place(kind, targetId, opts) {
      const fields = { until: opts.until ?? null, reason: opts.reason?.trim() ? opts.reason.trim() : null }
      const update = async (): Promise<Hold | null> => {
        const changed = await db.update(holds).set(fields).where(unreleased(kind, targetId)).returning()
        return changed[0] ? toHold(changed[0]) : null
      }
      const existing = await update()
      if (existing) return existing
      try {
        const row = { id: randomUUID(), targetKind: kind, targetId, ...fields, createdBy: 'user' as const, createdAt: now().toISOString(), releasedAt: null }
        await db.insert(holds).values(row)
        return toHold(row)
      } catch (err) {
        // Held by someone else between the update and the insert: the partial unique index refused.
        const raced = await update()
        if (raced) return raced
        throw err
      }
    },

    async release(kind, targetId) {
      const [changed] = await db.batch([
        db.update(holds).set({ releasedAt: now().toISOString() }).where(unreleased(kind, targetId)).returning(),
        reconcile()
      ])
      return changed[0] ? toHold(changed[0]) : null
    },

    active,

    async activeOf(kind) {
      const rows = await db
        .select()
        .from(holds)
        .where(and(eq(holds.targetKind, kind), isNull(holds.releasedAt)))
        .orderBy(asc(holds.createdAt), asc(sql`rowid`))
      return rows.map(toHold)
    },

    async releaseDue(at) {
      const [changed] = await db.batch([
        db
          .update(holds)
          .set({ releasedAt: now().toISOString() })
          .where(and(isNull(holds.releasedAt), isNotNull(holds.until), lte(holds.until, at.toISOString())))
          .returning(),
        reconcile()
      ])
      return changed.map(toHold).sort((a, b) => (a.until ?? '').localeCompare(b.until ?? ''))
    },

    async get(id) {
      const [row] = await db.select().from(holds).where(eq(holds.id, id))
      return row ? toHold(row) : null
    },

    async nextDue() {
      const [row] = await db
        .select({ until: holds.until })
        .from(holds)
        .where(and(isNull(holds.releasedAt), isNotNull(holds.until)))
        .orderBy(asc(holds.until))
        .limit(1)
      return row?.until ?? null
    },

    async reconcileDecisions() {
      const changed = await reconcile().returning({ id: decisions.id })
      return changed.length > 0
    },

    async releasedSince(kind, since) {
      const rows = await db
        .select()
        .from(holds)
        .where(
          and(
            eq(holds.targetKind, kind),
            isNotNull(holds.releasedAt),
            // At or after: one released in the same millisecond is told twice rather than never.
            since === null ? undefined : gte(holds.releasedAt, since)
          )
        )
        .orderBy(asc(holds.releasedAt), asc(sql`rowid`))
      return rows.map(toHold)
    }
  }
}
