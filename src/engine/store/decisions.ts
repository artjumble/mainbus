import { randomUUID } from 'node:crypto'
import { and, asc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { ANSWERED_VIA_LABELS, type AnsweredVia, type Decision, type DecisionAnswer } from '../../shared/domain'
import type { Db } from '../db/open'
import { decisions, holds, tickets } from '../db/schema'

/**
 * What Mainbus itself does with the answer to a question it asked on a role's behalf. Role ids are those of the
 * ticket run's snapshot; `fromRoleId` is the role that reported the problem.
 * - problem: the role reported a problem; one option hands it back to `toRoleId` (null: no earlier role), the
 *   other ("Keep going") reaches the agent as an answer.
 * - round_trip: the pair has gone back and forth too often; "Keep going" does the hand-back, "Take over" stops.
 */
export type DecisionAction =
  | { kind: 'problem'; fromRoleId: string; toRoleId: string | null; details: string }
  | { kind: 'round_trip'; fromRoleId: string; toRoleId: string; details: string }

export interface DecisionRepo {
  open(d: Omit<Decision, 'id' | 'status' | 'deferredUntil' | 'answer' | 'createdAt' | 'answeredAt' | 'answeredBy' | 'answeredVia'>, action?: DecisionAction): Promise<Decision>
  /** What Mainbus does with the decision's answer itself, or null when the answer goes to the agent as it is. */
  actionOf(id: string): Promise<DecisionAction | null>
  /** Throws unless the decision is still open (pending or deferred), and releases its hold; for one already answered, says where from ("Already answered from the board"). */
  answer(id: string, a: DecisionAnswer, via: AnsweredVia): Promise<Decision>
  /** Throws unless the decision is still pending or deferred. */
  expire(id: string): Promise<Decision>
  /** Puts a pending decision off until `until` (ISO) with a hold on it, in one step. Throws unless it is pending. */
  defer(id: string, until: string): Promise<Decision>
  /** The ticket's pending decisions: the ones waiting on the user now. */
  pending(ticketId: string): Promise<Decision[]>
  /** The ticket's deferred decisions, oldest first. */
  deferred(ticketId: string): Promise<Decision[]>
  /** The ticket's open decisions: pending and deferred. */
  unsettled(ticketId: string): Promise<Decision[]>
  /** Every decision of the ticket, whatever its status, in the order they were opened. */
  forTicket(ticketId: string): Promise<Decision[]>
  get(id: string): Promise<Decision>
  /** The workspace's decisions answered at or after `since` (every answered one when null), oldest answer first, with their ticket's number and title. */
  answeredSince(workspaceId: string, since: string | null): Promise<{ number: number; title: string; decision: Decision }[]>
}

function toDecision(row: typeof decisions.$inferSelect, deferredUntil: string | null = null): Decision {
  return {
    id: row.id,
    ticketId: row.ticketId,
    agentRunId: row.agentRunId,
    kind: row.kind as Decision['kind'],
    question: row.question,
    options: JSON.parse(row.options) as string[],
    recommended: row.recommended,
    allowAlways: row.allowAlways,
    status: row.status as Decision['status'],
    deferredUntil: row.status === 'deferred' ? deferredUntil : null,
    answer: row.answer === null ? null : (JSON.parse(row.answer) as DecisionAnswer),
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
    answeredBy: row.answeredBy as Decision['answeredBy'],
    answeredVia: row.answeredVia as Decision['answeredVia']
  }
}

/** Why a decision can't be settled again: someone answered it (and from where), or it expired or was cancelled. */
function notPending(d: Decision): Error {
  if (d.status === 'answered' && d.answeredVia) return new Error(`Already answered from ${ANSWERED_VIA_LABELS[d.answeredVia]}`)
  return new Error(`Decision ${d.id} is ${d.status}, not pending`)
}

export function createDecisionRepo(db: Db, now: () => Date): DecisionRepo {
  /** The decisions of `rows`, the deferred ones with the date of their unreleased hold. */
  async function withDates(rows: (typeof decisions.$inferSelect)[]): Promise<Decision[]> {
    const deferredIds = rows.filter((r) => r.status === 'deferred').map((r) => r.id)
    const dates = new Map<string, string | null>()
    if (deferredIds.length > 0) {
      const held = await db
        .select({ targetId: holds.targetId, until: holds.until })
        .from(holds)
        .where(and(eq(holds.targetKind, 'decision'), isNull(holds.releasedAt), inArray(holds.targetId, deferredIds)))
      for (const h of held) dates.set(h.targetId, h.until)
    }
    return rows.map((r) => toDecision(r, dates.get(r.id) ?? null))
  }

  async function get(id: string): Promise<Decision> {
    const [row] = await db.select().from(decisions).where(eq(decisions.id, id))
    if (!row) throw new Error(`Decision not found: ${id}`)
    return (await withDates([row]))[0]
  }

  async function withStatus(ticketId: string, statuses: string[]): Promise<Decision[]> {
    const rows = await db
      .select()
      .from(decisions)
      .where(and(eq(decisions.ticketId, ticketId), inArray(decisions.status, statuses)))
      .orderBy(asc(sql`rowid`))
    return withDates(rows)
  }

  /**
   * Moves an open (pending or deferred) decision to a new state and releases its hold in the same step; the status
   * check is part of the UPDATE, so only one caller wins.
   */
  async function settle(id: string, set: Partial<typeof decisions.$inferInsert>): Promise<Decision> {
    const current = await get(id)
    if (current.status !== 'pending' && current.status !== 'deferred') throw notPending(current)
    const [changed] = await db.batch([
      db
        .update(decisions)
        .set(set)
        .where(and(eq(decisions.id, id), inArray(decisions.status, ['pending', 'deferred'])))
        .returning({ id: decisions.id }),
      // Whoever settled it, its hold goes; a settled decision has nothing to come back for.
      db
        .update(holds)
        .set({ releasedAt: now().toISOString() })
        .where(and(eq(holds.targetKind, 'decision'), eq(holds.targetId, id), isNull(holds.releasedAt)))
    ])
    // Someone else settled it between our check and our update.
    if (changed.length === 0) throw notPending(await get(id))
    return get(id)
  }

  async function defer(id: string, until: string): Promise<Decision> {
    const current = await get(id)
    if (current.status === 'deferred') throw new Error(`Already deferred until ${current.deferredUntil ?? 'later'}`)
    if (current.status !== 'pending') throw notPending(current)
    const [changed] = await db.batch([
      db.update(decisions).set({ status: 'deferred' }).where(and(eq(decisions.id, id), eq(decisions.status, 'pending'))).returning({ id: decisions.id }),
      db.insert(holds).select(
        sql`select ${randomUUID()}, 'decision', ${id}, null, ${until}, 'user', ${now().toISOString()}, null
          where exists (select 1 from decisions where id = ${id} and status = 'deferred')
          and not exists (select 1 from holds where target_kind = 'decision' and target_id = ${id} and released_at is null)`
      )
    ])
    // Someone else settled or deferred it between our check and our update.
    if (changed.length === 0) throw notPending(await get(id))
    return get(id)
  }

  return {
    async open(d, action) {
      const id = randomUUID()
      await db.insert(decisions).values({
        id,
        ticketId: d.ticketId,
        agentRunId: d.agentRunId,
        kind: d.kind,
        question: d.question,
        options: JSON.stringify(d.options),
        recommended: d.recommended,
        allowAlways: d.allowAlways,
        action: action ? JSON.stringify(action) : null,
        status: 'pending',
        answer: null,
        createdAt: now().toISOString(),
        answeredAt: null
      })
      return get(id)
    },

    async actionOf(id) {
      const [row] = await db.select({ action: decisions.action }).from(decisions).where(eq(decisions.id, id))
      if (!row) throw new Error(`Decision not found: ${id}`)
      return row.action === null ? null : (JSON.parse(row.action) as DecisionAction)
    },

    answer(id, a, via) {
      return settle(id, {
        status: 'answered',
        answer: JSON.stringify(a),
        answeredAt: now().toISOString(),
        answeredBy: 'user',
        answeredVia: via
      })
    },

    expire(id) {
      return settle(id, { status: 'expired' })
    },

    defer,
    pending: (ticketId) => withStatus(ticketId, ['pending']),
    deferred: (ticketId) => withStatus(ticketId, ['deferred']),
    unsettled: (ticketId) => withStatus(ticketId, ['pending', 'deferred']),

    async forTicket(ticketId) {
      const rows = await db.select().from(decisions).where(eq(decisions.ticketId, ticketId)).orderBy(asc(sql`rowid`))
      return withDates(rows)
    },

    async answeredSince(workspaceId, since) {
      const rows = await db
        .select({ decision: decisions, number: tickets.number, title: tickets.title })
        .from(decisions)
        .innerJoin(tickets, eq(decisions.ticketId, tickets.id))
        .where(
          and(
            eq(tickets.workspaceId, workspaceId),
            eq(decisions.status, 'answered'),
            isNotNull(decisions.answeredAt),
            // At or after: one answered in the same millisecond is told twice rather than never.
            since === null ? undefined : gte(decisions.answeredAt, since)
          )
        )
        .orderBy(asc(decisions.answeredAt), asc(sql`${decisions}.rowid`))
      // Answered decisions are never deferred, so they carry no date.
      return rows.map((r) => ({ number: r.number, title: r.title, decision: toDecision(r.decision) }))
    },

    get
  }
}
