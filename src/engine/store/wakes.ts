import { randomUUID } from 'node:crypto'
import { and, asc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db/open'
import { orchestratorWakes } from '../db/schema'

export type WakeKind = 'failure' | 'stuck' | 'released_hold' | 'resurfaced' | 'done_review'

/** One piece of news waiting for the orchestrator's next wake turn. `ref` is the run, episode, hold or decision id. */
export interface Wake {
  id: string
  workspaceId: string
  kind: WakeKind
  ref: string
  createdAt: string
  presentedAt: string | null
}

export interface WakeRepo {
  /** Adds a row; false, adding nothing, when an unacknowledged row of this kind and ref exists. */
  add(workspaceId: string, kind: WakeKind, ref: string): Promise<boolean>
  /** The unacknowledged rows, oldest first. */
  pending(): Promise<Wake[]>
  /** Records that these rows were put in front of the orchestrator now (again, for a row presented before). */
  markPresented(ids: string[]): Promise<void>
  /** Acknowledges the rows that aren't yet. */
  ack(ids: string[]): Promise<void>
  /** The kind and ref of every row presented at or after `since` (every presented one when null). */
  presentedSince(since: string | null): Promise<{ kind: WakeKind; ref: string }[]>
  /** Whether a row of this kind and ref was presented and then acknowledged at or after `since` (a row dropped as gone does not count). */
  reviewedSince(kind: WakeKind, ref: string, since: string): Promise<boolean>
}

export function createWakeRepo(db: Db, now: () => Date): WakeRepo {
  return {
    async add(workspaceId, kind, ref) {
      const inserted = await db
        .insert(orchestratorWakes)
        .values({ id: randomUUID(), workspaceId, kind, ref, createdAt: now().toISOString() })
        .onConflictDoNothing()
        .returning({ id: orchestratorWakes.id })
      return inserted.length > 0
    },

    async pending() {
      return db
        .select({
          id: orchestratorWakes.id,
          workspaceId: orchestratorWakes.workspaceId,
          kind: orchestratorWakes.kind,
          ref: orchestratorWakes.ref,
          createdAt: orchestratorWakes.createdAt,
          presentedAt: orchestratorWakes.presentedAt
        })
        .from(orchestratorWakes)
        .where(isNull(orchestratorWakes.ackedAt))
        .orderBy(asc(orchestratorWakes.createdAt), asc(sql`rowid`))
    },

    async markPresented(ids) {
      if (ids.length === 0) return
      await db.update(orchestratorWakes).set({ presentedAt: now().toISOString() }).where(inArray(orchestratorWakes.id, ids))
    },

    async ack(ids) {
      if (ids.length === 0) return
      await db
        .update(orchestratorWakes)
        .set({ ackedAt: now().toISOString() })
        .where(and(inArray(orchestratorWakes.id, ids), isNull(orchestratorWakes.ackedAt)))
    },

    async reviewedSince(kind, ref, since) {
      const rows = await db
        .select({ id: orchestratorWakes.id })
        .from(orchestratorWakes)
        .where(
          and(
            eq(orchestratorWakes.kind, kind),
            eq(orchestratorWakes.ref, ref),
            isNotNull(orchestratorWakes.presentedAt),
            isNotNull(orchestratorWakes.ackedAt),
            gte(orchestratorWakes.ackedAt, since)
          )
        )
        .limit(1)
      return rows.length > 0
    },

    async presentedSince(since) {
      return db
        .select({ kind: orchestratorWakes.kind, ref: orchestratorWakes.ref })
        .from(orchestratorWakes)
        .where(
          and(isNotNull(orchestratorWakes.presentedAt), since === null ? undefined : gte(orchestratorWakes.presentedAt, since))
        )
    }
  }
}
