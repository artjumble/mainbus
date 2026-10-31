import { randomUUID } from 'node:crypto'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { Decision, DecisionAnswer } from '../../shared/domain'
import type { Db } from '../db/open'
import { decisions } from '../db/schema'

export interface DecisionRepo {
  open(d: Omit<Decision, 'id' | 'status' | 'answer' | 'createdAt' | 'answeredAt'>): Promise<Decision>
  /** Throws unless the decision is still pending. */
  answer(id: string, a: DecisionAnswer): Promise<Decision>
  /** Throws unless the decision is still pending. */
  expire(id: string): Promise<Decision>
  pending(ticketId: string): Promise<Decision[]>
  /** Every decision of the ticket, whatever its status, in the order they were opened. */
  forTicket(ticketId: string): Promise<Decision[]>
  get(id: string): Promise<Decision>
}

function toDecision(row: typeof decisions.$inferSelect): Decision {
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
    answer: row.answer === null ? null : (JSON.parse(row.answer) as DecisionAnswer),
    createdAt: row.createdAt,
    answeredAt: row.answeredAt
  }
}

export function createDecisionRepo(db: Db, now: () => Date): DecisionRepo {
  async function get(id: string): Promise<Decision> {
    const [row] = await db.select().from(decisions).where(eq(decisions.id, id))
    if (!row) throw new Error(`Decision not found: ${id}`)
    return toDecision(row)
  }

  /** Moves a pending decision to a new state; the status check is part of the UPDATE, so only one caller wins. */
  async function settle(id: string, set: Partial<typeof decisions.$inferInsert>): Promise<Decision> {
    const current = await get(id)
    if (current.status !== 'pending') {
      throw new Error(`Decision ${id} is ${current.status}, not pending`)
    }
    const changed = await db
      .update(decisions)
      .set(set)
      .where(and(eq(decisions.id, id), eq(decisions.status, 'pending')))
      .returning({ id: decisions.id })
    // Someone else settled it between our check and our update.
    if (changed.length === 0) throw new Error(`Decision ${id} is no longer pending`)
    return get(id)
  }

  return {
    async open(d) {
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
        status: 'pending',
        answer: null,
        createdAt: now().toISOString(),
        answeredAt: null
      })
      return get(id)
    },

    answer(id, a) {
      return settle(id, { status: 'answered', answer: JSON.stringify(a), answeredAt: now().toISOString() })
    },

    expire(id) {
      return settle(id, { status: 'expired' })
    },

    async pending(ticketId) {
      const rows = await db
        .select()
        .from(decisions)
        .where(and(eq(decisions.ticketId, ticketId), eq(decisions.status, 'pending')))
        .orderBy(asc(sql`rowid`))
      return rows.map(toDecision)
    },

    async forTicket(ticketId) {
      const rows = await db.select().from(decisions).where(eq(decisions.ticketId, ticketId)).orderBy(asc(sql`rowid`))
      return rows.map(toDecision)
    },

    get
  }
}
