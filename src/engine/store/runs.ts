import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import type { Effort } from '../../shared/domain'
import type { StoredEvent, ThreadEvent } from '../../shared/events'
import type { Db } from '../db/open'
import { agentEvents, agentRuns } from '../db/schema'

export type EndReason = 'handoff' | 'stopped' | 'failed'

export type AgentRunRow = {
  id: string
  ticketId: string
  role: string
  sessionId: string | null
  endReason: EndReason | null
  startedAt: string
  endedAt: string | null
}

export interface RunRepo {
  /** Starts a run and returns its id. */
  create(ticketId: string, role: string, model: string | null, effort: Effort | null): Promise<string>
  latest(ticketId: string): Promise<AgentRunRow | null>
  /** Every run of the ticket, oldest first. */
  listForTicket(ticketId: string): Promise<AgentRunRow[]>
  setSession(runId: string, sessionId: string): Promise<void>
  /** Ends an open run. Returns false, changing nothing, if the run had already ended. */
  end(runId: string, reason: EndReason): Promise<boolean>
  /** Appends to the run's thread; seq numbers start at 1 and are consecutive per run. */
  append(runId: string, event: ThreadEvent): Promise<StoredEvent>
  events(runId: string): Promise<StoredEvent[]>
}

const runColumns = {
  id: agentRuns.id,
  ticketId: agentRuns.ticketId,
  role: agentRuns.role,
  sessionId: agentRuns.sessionId,
  endReason: agentRuns.endReason,
  startedAt: agentRuns.startedAt,
  endedAt: agentRuns.endedAt
}

export function createRunRepo(db: Db, now: () => Date): RunRepo {
  return {
    async create(ticketId, role, model, effort) {
      const id = randomUUID()
      await db.insert(agentRuns).values({ id, ticketId, role, model, effort, startedAt: now().toISOString() })
      return id
    },

    async latest(ticketId) {
      const [row] = await db
        .select(runColumns)
        .from(agentRuns)
        .where(eq(agentRuns.ticketId, ticketId))
        // rowid breaks ties between runs started in the same millisecond.
        .orderBy(desc(agentRuns.startedAt), desc(sql`rowid`))
        .limit(1)
      return row ?? null
    },

    listForTicket(ticketId) {
      return db
        .select(runColumns)
        .from(agentRuns)
        .where(eq(agentRuns.ticketId, ticketId))
        .orderBy(asc(agentRuns.startedAt), asc(sql`rowid`))
    },

    async setSession(runId, sessionId) {
      await db.update(agentRuns).set({ sessionId }).where(eq(agentRuns.id, runId))
    },

    async end(runId, reason) {
      // The open-run check is part of the UPDATE, so of two concurrent enders only one wins.
      const ended = await db
        .update(agentRuns)
        .set({ endReason: reason, endedAt: now().toISOString() })
        .where(and(eq(agentRuns.id, runId), isNull(agentRuns.endReason)))
        .returning({ id: agentRuns.id })
      return ended.length > 0
    },

    async append(runId, event) {
      const at = now().toISOString()
      // The next seq is computed inside the insert so concurrent appends cannot pick the same number.
      const [row] = await db
        .insert(agentEvents)
        .values({
          runId,
          seq: sql`(select coalesce(max(${agentEvents.seq}), 0) + 1 from ${agentEvents} where ${agentEvents.runId} = ${runId})`,
          at,
          json: JSON.stringify(event)
        })
        .returning({ seq: agentEvents.seq })
      return { runId, seq: row.seq, at, event }
    },

    async events(runId) {
      const rows = await db.select().from(agentEvents).where(eq(agentEvents.runId, runId)).orderBy(asc(agentEvents.seq))
      return rows.map((r) => ({ runId: r.runId, seq: r.seq, at: r.at, event: JSON.parse(r.json) as ThreadEvent }))
    }
  }
}
