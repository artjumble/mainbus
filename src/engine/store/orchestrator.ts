import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import type { OrchestratorRun, StoredEvent, ThreadEvent } from '../../shared/events'
import type { Db } from '../db/open'
import { orchestratorEvents, orchestratorRuns } from '../db/schema'

export type OrchestratorRunRow = OrchestratorRun & { sessionId: string | null }

export interface OrchestratorRepo {
  create(): Promise<OrchestratorRunRow>
  /** The latest run if it is still open: the one the next message resumes. */
  latestOpen(): Promise<OrchestratorRunRow | null>
  /** Every run, oldest first. */
  list(): Promise<OrchestratorRunRow[]>
  setSession(runId: string, sessionId: string): Promise<void>
  /** Ends an open run; returns false, changing nothing, if it had already ended. */
  end(runId: string, reason: 'resume_failed'): Promise<boolean>
  /** Appends to the run's thread; seq numbers start at 1 and are consecutive per run. */
  append(runId: string, event: ThreadEvent): Promise<StoredEvent>
  events(runId: string): Promise<StoredEvent[]>
}

const columns = {
  id: orchestratorRuns.id,
  sessionId: orchestratorRuns.sessionId,
  startedAt: orchestratorRuns.startedAt,
  endedAt: orchestratorRuns.endedAt,
  endReason: orchestratorRuns.endReason
}

export function createOrchestratorRepo(db: Db, now: () => Date): OrchestratorRepo {
  return {
    async create() {
      const row = { id: randomUUID(), sessionId: null, startedAt: now().toISOString(), endedAt: null, endReason: null }
      await db.insert(orchestratorRuns).values({ id: row.id, startedAt: row.startedAt })
      return row
    },

    async latestOpen() {
      const [row] = await db
        .select(columns)
        .from(orchestratorRuns)
        // rowid breaks ties between runs started in the same millisecond.
        .orderBy(desc(orchestratorRuns.startedAt), desc(sql`rowid`))
        .limit(1)
      return row && row.endReason === null ? row : null
    },

    list() {
      return db.select(columns).from(orchestratorRuns).orderBy(asc(orchestratorRuns.startedAt), asc(sql`rowid`))
    },

    async setSession(runId, sessionId) {
      await db.update(orchestratorRuns).set({ sessionId }).where(eq(orchestratorRuns.id, runId))
    },

    async end(runId, reason) {
      const ended = await db
        .update(orchestratorRuns)
        .set({ endReason: reason, endedAt: now().toISOString() })
        .where(and(eq(orchestratorRuns.id, runId), isNull(orchestratorRuns.endReason)))
        .returning({ id: orchestratorRuns.id })
      return ended.length > 0
    },

    async append(runId, event) {
      const at = now().toISOString()
      // The next seq is computed inside the insert so concurrent appends cannot pick the same number.
      const [row] = await db
        .insert(orchestratorEvents)
        .values({
          runId,
          seq: sql`(select coalesce(max(${orchestratorEvents.seq}), 0) + 1 from ${orchestratorEvents} where ${orchestratorEvents.runId} = ${runId})`,
          at,
          json: JSON.stringify(event)
        })
        .returning({ seq: orchestratorEvents.seq })
      return { runId, seq: row.seq, at, event }
    },

    async events(runId) {
      const rows = await db
        .select()
        .from(orchestratorEvents)
        .where(eq(orchestratorEvents.runId, runId))
        .orderBy(asc(orchestratorEvents.seq))
      return rows.map((r) => ({ runId: r.runId, seq: r.seq, at: r.at, event: JSON.parse(r.json) as ThreadEvent }))
    }
  }
}
