import { asc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/open'
import { pendingCleanups } from '../db/schema'

export interface PendingCleanup {
  ticketId: string
  repoPath: string
  path: string
  branch: string
}

/** Worktree removals that were decided but may not have finished (for example, the app quit mid-removal). */
export interface PendingCleanupRepo {
  /** Records a decided removal; adding the same ticket again replaces its row. */
  add(ticketId: string, repoPath: string, path: string, branch: string): Promise<void>
  done(ticketId: string): Promise<void>
  list(): Promise<PendingCleanup[]>
}

export function createCleanupRepo(db: Db, now: () => Date): PendingCleanupRepo {
  return {
    async add(ticketId, repoPath, path, branch) {
      const row = { ticketId, repoPath, worktreePath: path, branch, createdAt: now().toISOString() }
      await db
        .insert(pendingCleanups)
        .values(row)
        .onConflictDoUpdate({ target: pendingCleanups.ticketId, set: row })
    },

    async done(ticketId) {
      await db.delete(pendingCleanups).where(eq(pendingCleanups.ticketId, ticketId))
    },

    async list() {
      const rows = await db.select().from(pendingCleanups).orderBy(asc(sql`rowid`))
      return rows.map((r) => ({
        ticketId: r.ticketId,
        repoPath: r.repoPath,
        path: r.worktreePath,
        branch: r.branch
      }))
    }
  }
}
