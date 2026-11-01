import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import type { LineupRole } from '../../shared/domain'
import type { StoredEvent, ThreadEvent } from '../../shared/events'
import type { Db } from '../db/open'
import { agentEvents, agentRuns, ticketRuns } from '../db/schema'

export type EndReason = 'handoff' | 'stopped' | 'failed'
export type TicketRunStatus = 'running' | 'done' | 'stopped' | 'failed'

export type AgentRunRow = {
  id: string
  ticketId: string
  ticketRunId: string
  /** The id of the run's role in its ticket run's snapshot. */
  roleId: string
  role: string
  sessionId: string | null
  endReason: EndReason | null
  startedAt: string
  endedAt: string | null
}

export type TicketRunRow = {
  id: string
  ticketId: string
  /** The roles ticked at start, in lineup order, as they were then. */
  roles: LineupRole[]
  status: TicketRunStatus
  startedAt: string
  endedAt: string | null
}

export interface RunRepo {
  /** Starts a ticket run of `roles` (in order, at least one) and its first role's agent run; returns that run's id. */
  create(ticketId: string, roles: LineupRole[]): Promise<string>
  /**
   * Hands `prevRunId` on to `next`, a later role of the same ticket run: starts its agent run, then ends the
   * previous one as handed off. Returns the new run's id, or null, changing nothing, if the previous run had
   * already ended or its ticket run is no longer running. The new run exists before the old one ends, so the
   * ticket's latest run is never a handed-off one mid-lineup.
   */
  handOn(prevRunId: string, next: LineupRole): Promise<string | null>
  latest(ticketId: string): Promise<AgentRunRow | null>
  /** Every run of the ticket, oldest first. */
  listForTicket(ticketId: string): Promise<AgentRunRow[]>
  /** Every agent run of a ticket run, oldest first. */
  listForTicketRun(ticketRunId: string): Promise<AgentRunRow[]>
  ticketRun(ticketRunId: string): Promise<TicketRunRow>
  setSession(runId: string, sessionId: string): Promise<void>
  /**
   * Ends an open run, and its ticket run with it: a handoff ends the ticket run as done (it was the last role),
   * a stop or failure as stopped or failed. Returns false, changing nothing, if the run had already ended.
   */
  end(runId: string, reason: EndReason): Promise<boolean>
  /** Appends to the run's thread; seq numbers start at 1 and are consecutive per run. */
  append(runId: string, event: ThreadEvent): Promise<StoredEvent>
  events(runId: string): Promise<StoredEvent[]>
}

const runColumns = {
  id: agentRuns.id,
  ticketId: agentRuns.ticketId,
  ticketRunId: agentRuns.ticketRunId,
  roleId: agentRuns.roleId,
  role: agentRuns.role,
  sessionId: agentRuns.sessionId,
  endReason: agentRuns.endReason,
  startedAt: agentRuns.startedAt,
  endedAt: agentRuns.endedAt
}

const TICKET_RUN_END: Record<EndReason, TicketRunStatus> = { handoff: 'done', stopped: 'stopped', failed: 'failed' }

export function createRunRepo(db: Db, now: () => Date): RunRepo {
  function agentRunValues(ticketId: string, ticketRunId: string, role: LineupRole) {
    return {
      id: randomUUID(),
      ticketId,
      ticketRunId,
      roleId: role.id,
      role: role.name,
      model: role.model,
      effort: role.effort,
      startedAt: now().toISOString()
    }
  }

  return {
    async create(ticketId, roles) {
      const first = roles[0]
      if (!first) throw new Error('A ticket run needs at least one role')
      const ticketRunId = randomUUID()
      const run = agentRunValues(ticketId, ticketRunId, first)
      await db.transaction(async (tx) => {
        await tx
          .insert(ticketRuns)
          .values({ id: ticketRunId, ticketId, roles: JSON.stringify(roles), status: 'running', startedAt: run.startedAt })
        await tx.insert(agentRuns).values(run)
      })
      return run.id
    },

    async handOn(prevRunId, next) {
      const [prev] = await db.select(runColumns).from(agentRuns).where(eq(agentRuns.id, prevRunId))
      if (!prev) return null
      const v = agentRunValues(prev.ticketId, prev.ticketRunId, next)
      // One statement, so the checks and the insert can't be split by a concurrent stop or failure.
      const inserted = await db.all<unknown>(sql`
        insert into ${agentRuns} (id, ticket_id, ticket_run_id, role_id, role, model, effort, started_at)
        select ${v.id}, ${v.ticketId}, ${v.ticketRunId}, ${v.roleId}, ${v.role}, ${v.model}, ${v.effort}, ${v.startedAt}
        where exists (select 1 from ${agentRuns} where id = ${prevRunId} and end_reason is null)
          and exists (select 1 from ${ticketRuns} where id = ${prev.ticketRunId} and status = 'running')
        returning id`)
      if (inserted.length === 0) return null
      await db
        .update(agentRuns)
        .set({ endReason: 'handoff', endedAt: now().toISOString() })
        .where(and(eq(agentRuns.id, prevRunId), isNull(agentRuns.endReason)))
      return v.id
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

    listForTicketRun(ticketRunId) {
      return db
        .select(runColumns)
        .from(agentRuns)
        .where(eq(agentRuns.ticketRunId, ticketRunId))
        .orderBy(asc(agentRuns.startedAt), asc(sql`rowid`))
    },

    async ticketRun(ticketRunId) {
      const [row] = await db.select().from(ticketRuns).where(eq(ticketRuns.id, ticketRunId))
      if (!row) throw new Error(`Ticket run not found: ${ticketRunId}`)
      return { ...row, roles: JSON.parse(row.roles) as LineupRole[] }
    },

    async setSession(runId, sessionId) {
      await db.update(agentRuns).set({ sessionId }).where(eq(agentRuns.id, runId))
    },

    async end(runId, reason) {
      const endedAt = now().toISOString()
      // The open-run check is part of the UPDATE, so of two concurrent enders only one wins.
      const [ended] = await db
        .update(agentRuns)
        .set({ endReason: reason, endedAt })
        .where(and(eq(agentRuns.id, runId), isNull(agentRuns.endReason)))
        .returning({ ticketRunId: agentRuns.ticketRunId })
      if (!ended) return false
      await db
        .update(ticketRuns)
        .set({ status: TICKET_RUN_END[reason], endedAt })
        .where(and(eq(ticketRuns.id, ended.ticketRunId), eq(ticketRuns.status, 'running')))
      return true
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
