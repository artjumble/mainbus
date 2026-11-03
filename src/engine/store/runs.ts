import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type { DeclaredWait, LineupRole } from '../../shared/domain'
import type { StoredEvent, ThreadEvent } from '../../shared/events'
import type { Db } from '../db/open'
import { agentEvents, agentRuns, stuckEpisodes, ticketRuns } from '../db/schema'

/** `handed_back`: the run's role reported a problem and handed the ticket back to an earlier role. */
export type EndReason = 'handoff' | 'handed_back' | 'stopped' | 'failed' | 'replaced'
/**
 * The reasons `end` takes: a hand-back only ends a run through `handBack`, and a replacement through `replace`;
 * neither ends the ticket run.
 */
export type EndingReason = Exclude<EndReason, 'handed_back' | 'replaced'>
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
  /** The snapshot id of the role this run's handoff returns to instead of the next role; null for the next role. */
  returnToRoleId: string | null
  /** The user skipped the run's role: it ended as handed off, with a handoff summary Mainbus generated. */
  skipped: boolean
  /** The agent's `claude` process id and start time, until what it left running has been swept; null when none is recorded. */
  processPid: number | null
  processStartedAt: number | null
  /** The wait the agent declared with report_waiting (it may be past); null when it declared none, or the run has ended. */
  declaredWait: DeclaredWait | null
  /** How many redirects the user confirmed for this run. */
  redirectCount: number
  /** The model and effort the run launches with when they differ from its role's in the ticket run's snapshot; null otherwise. */
  model: string | null
  effort: string | null
  /** Extra instructions the user added when this run replaced another, on top of the ticket run's; null for none. */
  extraInstructions: string | null
  /** The run that replaced this one, when it ended as replaced. */
  replacedBy: string | null
  /** The handoff summary generated from this run's log when it was replaced, or null. */
  handoffSummary: string | null
  /** Its place in the queue for a slot (smaller starts first); null when the run is not queued. */
  queuedSeq: number | null
  /** The message a queued run starts with once it gets a slot; null when it is not queued. */
  queuedPrompt: string | null
}

/** How a run ends when the user skipped its role. */
export interface EndOptions {
  skipped?: boolean
}

export type TicketRunRow = {
  id: string
  ticketId: string
  /** The roles ticked at start, in lineup order, as they were then. */
  roles: LineupRole[]
  /** Added to every role's prompt in this run, as confirmed by the user at start; null for none. */
  extraInstructions: string | null
  status: TicketRunStatus
  startedAt: string
  endedAt: string | null
}

/** What a replacement run starts with: the user's choices for it and the summary of the run it replaces. */
export interface ReplaceOptions {
  model: string
  effort: string
  extraInstructions: string | null
  /** The handoff summary generated from the replaced run's log. */
  handoffSummary: string
}

export interface RunRepo {
  /**
   * Starts a ticket run of `roles` (in order, at least one) and its first role's agent run; returns that run's id.
   * `extraInstructions` go to every role of the run.
   */
  create(ticketId: string, roles: LineupRole[], extraInstructions?: string | null): Promise<string>
  /**
   * Hands `prevRunId` on to `next`, a role of the same ticket run: starts its agent run, then ends the previous
   * one as handed off. Returns the new run, or null, changing nothing, if the previous run had already ended or
   * its ticket run is no longer running. The new run exists before the old one ends, so the ticket's latest run
   * is never a handed-off one mid-lineup. When `next` already ran in this ticket run, the new run carries on
   * its latest run's session and return role. With `skipped`, the previous run is marked as skipped.
   */
  handOn(prevRunId: string, next: LineupRole, opts?: EndOptions): Promise<AgentRunRow | null>
  /**
   * Hands `prevRunId` back to `to`, an earlier role of the same ticket run, as `handOn` does, but ends the
   * previous run as handed back. The new run carries on `to`'s latest session, and its handoff returns to
   * `returnToRoleId`.
   */
  handBack(prevRunId: string, to: LineupRole, returnToRoleId: string): Promise<AgentRunRow | null>
  /**
   * Replaces `prevRunId` with a fresh run of the same role in the same ticket run (a new session, the same return
   * role), then ends the previous one as replaced, pointing at the new one with its handoff summary. Returns the new
   * run, or null, changing nothing, if the previous run had already ended or its ticket run is no longer running.
   * The ticket run, its snapshot and every other role's runs are untouched.
   */
  replace(prevRunId: string, opts: ReplaceOptions): Promise<AgentRunRow | null>
  /** How many runs of the role were replaced in the ticket run. */
  replacedCount(ticketRunId: string, roleId: string): Promise<number>
  latest(ticketId: string): Promise<AgentRunRow | null>
  /** The run with this id, or null. */
  get(runId: string): Promise<AgentRunRow | null>
  /** Every run of the ticket, oldest first. */
  listForTicket(ticketId: string): Promise<AgentRunRow[]>
  /** Every agent run of a ticket run, oldest first. */
  listForTicketRun(ticketRunId: string): Promise<AgentRunRow[]>
  /** Every run that has not ended, oldest first. */
  listOpen(): Promise<AgentRunRow[]>
  /**
   * Puts an open run in the queue for a slot, at the back, with the message it starts with. A run already queued keeps
   * its place, and the message is added to the one it has.
   */
  enqueue(runId: string, prompt: string): Promise<void>
  /** Takes the run out of the queue; nothing happens when it is not in it. */
  dequeue(runId: string): Promise<void>
  /** The open runs waiting for a slot, first in first out. */
  queued(): Promise<AgentRunRow[]>
  ticketRun(ticketRunId: string): Promise<TicketRunRow>
  setSession(runId: string, sessionId: string): Promise<void>
  /** Records the run's `claude` process (or, with null, that nothing of it is left to sweep). */
  setProcess(runId: string, process: { pid: number; startedAt: number } | null): Promise<void>
  /** Records the wait the run's agent declared, replacing an earlier one. */
  setDeclaredWait(runId: string, wait: DeclaredWait): Promise<void>
  /**
   * Ends an open run, and its ticket run with it: a handoff ends the ticket run as done (it was the last role),
   * a stop or failure as stopped or failed. Returns false, changing nothing, if the run had already ended.
   * With `skipped`, the run is marked as skipped. An ended run has no declared wait and no open stuck episode.
   */
  end(runId: string, reason: EndingReason, opts?: EndOptions): Promise<boolean>
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
  endedAt: agentRuns.endedAt,
  returnToRoleId: agentRuns.returnTo,
  skipped: agentRuns.skipped,
  processPid: agentRuns.processPid,
  processStartedAt: agentRuns.processStartedAt,
  declaredWait: agentRuns.declaredWait,
  redirectCount: agentRuns.redirectCount,
  model: agentRuns.model,
  effort: agentRuns.effort,
  extraInstructions: agentRuns.extraInstructions,
  replacedBy: agentRuns.replacedBy,
  handoffSummary: agentRuns.handoffSummary,
  queuedSeq: agentRuns.queuedSeq,
  queuedPrompt: agentRuns.queuedPrompt
}

/** A selected run with its declared wait (stored as JSON) parsed. */
function toRun(row: Omit<AgentRunRow, 'declaredWait'> & { declaredWait: string | null }): AgentRunRow {
  return { ...row, declaredWait: row.declaredWait === null ? null : (JSON.parse(row.declaredWait) as DeclaredWait) }
}

/** What an ending run sets so it leaves the queue. */
const NOT_QUEUED = { queuedSeq: null, queuedPrompt: null } as const

const TICKET_RUN_END: Record<EndingReason, TicketRunStatus> = { handoff: 'done', stopped: 'stopped', failed: 'failed' }

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

  async function get(runId: string): Promise<AgentRunRow | null> {
    const [row] = await db.select(runColumns).from(agentRuns).where(eq(agentRuns.id, runId))
    return row ? toRun(row) : null
  }

  /** A run that ends has no open stuck episode left. */
  const closeEpisode = (runId: string) =>
    db
      .update(stuckEpisodes)
      .set({ closedAt: now().toISOString() })
      .where(and(eq(stuckEpisodes.agentRunId, runId), isNull(stuckEpisodes.closedAt)))

  /**
   * Starts `role`'s run after `prevRunId`, then ends `prevRunId` with `reason`; see handOn. `returnTo` is the
   * new run's return role: a role id, or 'inherit' for that of the role's latest run in the ticket run.
   */
  async function passTo(
    prevRunId: string,
    role: LineupRole,
    returnTo: string | 'inherit',
    reason: 'handoff' | 'handed_back',
    skipped = false
  ): Promise<AgentRunRow | null> {
    const prev = await get(prevRunId)
    if (!prev) return null
    const v = agentRunValues(prev.ticketId, prev.ticketRunId, role)
    const latestOfRole = (column: string) => sql`(
      select ${sql.raw(column)} from ${agentRuns}
      where ticket_run_id = ${v.ticketRunId} and role_id = ${v.roleId}
      order by started_at desc, rowid desc limit 1)`
    const returnToValue = returnTo === 'inherit' ? latestOfRole('return_to') : sql`${returnTo}`
    // One statement, so the checks and the insert can't be split by a concurrent stop or failure.
    const inserted = await db.all<unknown>(sql`
      insert into ${agentRuns} (id, ticket_id, ticket_run_id, role_id, role, model, effort, started_at, session_id, return_to)
      select ${v.id}, ${v.ticketId}, ${v.ticketRunId}, ${v.roleId}, ${v.role}, ${v.model}, ${v.effort}, ${v.startedAt},
        ${latestOfRole('session_id')}, ${returnToValue}
      where exists (select 1 from ${agentRuns} where id = ${prevRunId} and end_reason is null)
        and exists (select 1 from ${ticketRuns} where id = ${prev.ticketRunId} and status = 'running')
      returning id`)
    if (inserted.length === 0) return null
    await db
      .update(agentRuns)
      .set({ endReason: reason, endedAt: now().toISOString(), declaredWait: null, ...NOT_QUEUED, ...(skipped ? { skipped: true } : {}) })
      .where(and(eq(agentRuns.id, prevRunId), isNull(agentRuns.endReason)))
    await closeEpisode(prevRunId)
    return get(v.id)
  }

  return {
    async create(ticketId, roles, extraInstructions = null) {
      const first = roles[0]
      if (!first) throw new Error('A ticket run needs at least one role')
      const ticketRunId = randomUUID()
      const run = agentRunValues(ticketId, ticketRunId, first)
      await db.transaction(async (tx) => {
        await tx.insert(ticketRuns).values({
          id: ticketRunId,
          ticketId,
          roles: JSON.stringify(roles),
          extraInstructions,
          status: 'running',
          startedAt: run.startedAt
        })
        await tx.insert(agentRuns).values(run)
      })
      return run.id
    },

    handOn(prevRunId, next, opts) {
      return passTo(prevRunId, next, 'inherit', 'handoff', opts?.skipped === true)
    },

    handBack(prevRunId, to, returnToRoleId) {
      return passTo(prevRunId, to, returnToRoleId, 'handed_back')
    },

    async replace(prevRunId, opts) {
      const prev = await get(prevRunId)
      if (!prev) return null
      const id = randomUUID()
      const startedAt = now().toISOString()
      // One statement, so the checks and the insert can't be split by a concurrent stop or failure.
      const inserted = await db.all<unknown>(sql`
        insert into ${agentRuns} (id, ticket_id, ticket_run_id, role_id, role, model, effort, started_at, session_id, return_to, extra_instructions)
        select ${id}, ${prev.ticketId}, ${prev.ticketRunId}, ${prev.roleId}, ${prev.role}, ${opts.model}, ${opts.effort}, ${startedAt},
          null, ${prev.returnToRoleId}, ${opts.extraInstructions}
        where exists (select 1 from ${agentRuns} where id = ${prevRunId} and end_reason is null)
          and exists (select 1 from ${ticketRuns} where id = ${prev.ticketRunId} and status = 'running')
        returning id`)
      if (inserted.length === 0) return null
      await db
        .update(agentRuns)
        .set({ endReason: 'replaced', endedAt: now().toISOString(), declaredWait: null, ...NOT_QUEUED, replacedBy: id, handoffSummary: opts.handoffSummary })
        .where(and(eq(agentRuns.id, prevRunId), isNull(agentRuns.endReason)))
      await closeEpisode(prevRunId)
      return get(id)
    },

    async replacedCount(ticketRunId, roleId) {
      const [row] = await db
        .select({ n: sql<number>`count(*)` })
        .from(agentRuns)
        .where(and(eq(agentRuns.ticketRunId, ticketRunId), eq(agentRuns.roleId, roleId), eq(agentRuns.endReason, 'replaced')))
      return Number(row?.n ?? 0)
    },

    async get(runId) {
      const [row] = await db.select(runColumns).from(agentRuns).where(eq(agentRuns.id, runId))
      return row ? toRun(row) : null
    },

    async latest(ticketId) {
      const [row] = await db
        .select(runColumns)
        .from(agentRuns)
        .where(eq(agentRuns.ticketId, ticketId))
        // rowid breaks ties between runs started in the same millisecond.
        .orderBy(desc(agentRuns.startedAt), desc(sql`rowid`))
        .limit(1)
      return row ? toRun(row) : null
    },

    async listForTicket(ticketId) {
      const rows = await db
        .select(runColumns)
        .from(agentRuns)
        .where(eq(agentRuns.ticketId, ticketId))
        .orderBy(asc(agentRuns.startedAt), asc(sql`rowid`))
      return rows.map(toRun)
    },

    async listForTicketRun(ticketRunId) {
      const rows = await db
        .select(runColumns)
        .from(agentRuns)
        .where(eq(agentRuns.ticketRunId, ticketRunId))
        .orderBy(asc(agentRuns.startedAt), asc(sql`rowid`))
      return rows.map(toRun)
    },

    async listOpen() {
      const rows = await db
        .select(runColumns)
        .from(agentRuns)
        .where(isNull(agentRuns.endReason))
        .orderBy(asc(agentRuns.startedAt), asc(sql`rowid`))
      return rows.map(toRun)
    },

    async enqueue(runId, prompt) {
      // The next place is computed inside the update, so two runs queued at once can't take the same one.
      await db
        .update(agentRuns)
        .set({
          queuedSeq: sql`coalesce(${agentRuns.queuedSeq}, (select coalesce(max(queued_seq), 0) + 1 from agent_runs))`,
          queuedPrompt: sql`case when ${agentRuns.queuedSeq} is null then ${prompt} else coalesce(${agentRuns.queuedPrompt}, '') || char(10) || char(10) || ${prompt} end`
        })
        .where(and(eq(agentRuns.id, runId), isNull(agentRuns.endReason)))
    },

    async dequeue(runId) {
      await db.update(agentRuns).set(NOT_QUEUED).where(eq(agentRuns.id, runId))
    },

    async queued() {
      const rows = await db
        .select(runColumns)
        .from(agentRuns)
        .where(and(isNull(agentRuns.endReason), isNotNull(agentRuns.queuedSeq)))
        .orderBy(asc(agentRuns.queuedSeq))
      return rows.map(toRun)
    },

    async ticketRun(ticketRunId) {
      const [row] = await db.select().from(ticketRuns).where(eq(ticketRuns.id, ticketRunId))
      if (!row) throw new Error(`Ticket run not found: ${ticketRunId}`)
      return { ...row, roles: JSON.parse(row.roles) as LineupRole[] }
    },

    async setSession(runId, sessionId) {
      await db.update(agentRuns).set({ sessionId }).where(eq(agentRuns.id, runId))
    },

    async setProcess(runId, process) {
      await db
        .update(agentRuns)
        .set({ processPid: process?.pid ?? null, processStartedAt: process?.startedAt ?? null })
        .where(eq(agentRuns.id, runId))
    },

    async setDeclaredWait(runId, wait) {
      await db.update(agentRuns).set({ declaredWait: JSON.stringify(wait) }).where(eq(agentRuns.id, runId))
    },

    async end(runId, reason, opts) {
      const endedAt = now().toISOString()
      // The open-run check is part of the UPDATE, so of two concurrent enders only one wins.
      const [ended] = await db
        .update(agentRuns)
        .set({ endReason: reason, endedAt, declaredWait: null, ...NOT_QUEUED, ...(opts?.skipped ? { skipped: true } : {}) })
        .where(and(eq(agentRuns.id, runId), isNull(agentRuns.endReason)))
        .returning({ ticketRunId: agentRuns.ticketRunId })
      if (!ended) return false
      await closeEpisode(runId)
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
