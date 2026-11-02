import { randomUUID } from 'node:crypto'
import { and, asc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { DraftColumn, Proposal, ProposalKindName, ProposalOrigin } from '../../shared/proposals'
import type { Db } from '../db/open'
import { proposals, tickets } from '../db/schema'

export interface NewProposal {
  workspaceId: string
  orchestratorRunId: string
  kind: ProposalKindName
  /** 'orchestrator' when absent. */
  origin?: ProposalOrigin
  payload: unknown
  evidence: string | null
}

export interface ProposalRepo {
  create(p: NewProposal): Promise<Proposal>
  get(id: string): Promise<Proposal>
  /** Every proposal, oldest first. */
  list(): Promise<Proposal[]>
  /** Decides a pending proposal for carrying out. Throws unless it is still pending, so only one caller wins. */
  claim(id: string, status: 'confirmed' | 'overridden'): Promise<Proposal>
  /** Throws unless the proposal is still pending. */
  reject(id: string): Promise<Proposal>
  /** Records the result of carrying out a claimed proposal. */
  finish(id: string, result: unknown): Promise<Proposal>
  /**
   * The statement that records a create_tickets result from the tickets with these ids, as they are stored, for
   * the same batch that creates them: the proposal has its result exactly when the tickets exist.
   */
  ticketsResultStatement(id: string, ticketIds: string[], column: DraftColumn): BatchItem<'sqlite'>
  /** Proposals claimed but with no result: Mainbus quit while carrying them out. Oldest first. */
  unfinished(): Promise<Proposal[]>
  /** Carrying out a claimed proposal threw: it is failed, with the error as its result. */
  fail(id: string, error: string): Promise<Proposal>
  /** A pending proposal that can no longer be carried out: it is failed with `error`, decided now. Null when it isn't pending. */
  failPending(id: string, error: string): Promise<Proposal | null>
  /** The proposals decided at or after `since` (every decided one when null), oldest decision first. */
  decidedSince(since: string | null): Promise<Proposal[]>
}

function toProposal(row: typeof proposals.$inferSelect): Proposal {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    orchestratorRunId: row.orchestratorRunId,
    kind: row.kind as ProposalKindName,
    origin: row.origin,
    payload: JSON.parse(row.payload) as unknown,
    evidence: row.evidence,
    status: row.status,
    result: row.result === null ? null : (JSON.parse(row.result) as unknown),
    createdAt: row.createdAt,
    decidedAt: row.decidedAt
  }
}

export function createProposalRepo(db: Db, now: () => Date): ProposalRepo {
  async function get(id: string): Promise<Proposal> {
    const [row] = await db.select().from(proposals).where(eq(proposals.id, id))
    if (!row) throw new Error(`Proposal not found: ${id}`)
    return toProposal(row)
  }

  /** Decides a pending proposal; the status check is part of the UPDATE, so only one caller wins. */
  async function decide(id: string, status: 'confirmed' | 'overridden' | 'rejected'): Promise<Proposal> {
    const current = await get(id)
    if (current.status !== 'pending') throw new Error(`Proposal ${id} is ${current.status}, not pending`)
    const changed = await db
      .update(proposals)
      .set({ status, decidedAt: now().toISOString() })
      .where(and(eq(proposals.id, id), eq(proposals.status, 'pending')))
      .returning({ id: proposals.id })
    // Someone else decided it between our check and our update.
    if (changed.length === 0) throw new Error(`Proposal ${id} is no longer pending`)
    return get(id)
  }

  return {
    async create(p) {
      const id = randomUUID()
      await db.insert(proposals).values({
        id,
        workspaceId: p.workspaceId,
        orchestratorRunId: p.orchestratorRunId,
        kind: p.kind,
        origin: p.origin ?? 'orchestrator',
        payload: JSON.stringify(p.payload),
        evidence: p.evidence,
        status: 'pending',
        result: null,
        createdAt: now().toISOString(),
        decidedAt: null
      })
      return get(id)
    },

    get,

    async list() {
      const rows = await db.select().from(proposals).orderBy(asc(proposals.createdAt), asc(sql`rowid`))
      return rows.map(toProposal)
    },

    claim: decide,

    reject: (id) => decide(id, 'rejected'),

    async finish(id, result) {
      await db.update(proposals).set({ result: JSON.stringify(result) }).where(eq(proposals.id, id))
      return get(id)
    },

    ticketsResultStatement(id, ticketIds, column) {
      const idList = sql.join(ticketIds.map((t) => sql`${t}`), sql`, `)
      // json() keeps each piece JSON rather than text inside the enclosing json_object.
      const result = sql`json_object('tickets', json((select json_group_array(json(j)) from (select json_object('id', ${tickets.id}, 'number', ${tickets.number}, 'title', ${tickets.title}) as j from ${tickets} where ${tickets.id} in (${idList}) order by ${tickets.number}))), 'column', ${column})`
      return db
        .update(proposals)
        .set({ result })
        .where(and(eq(proposals.id, id), isNull(proposals.result), inArray(proposals.status, ['confirmed', 'overridden'])))
    },

    async unfinished() {
      const rows = await db
        .select()
        .from(proposals)
        .where(and(inArray(proposals.status, ['confirmed', 'overridden']), isNull(proposals.result)))
        .orderBy(asc(proposals.createdAt), asc(sql`rowid`))
      return rows.map(toProposal)
    },

    async fail(id, error) {
      await db
        .update(proposals)
        .set({ status: 'failed', result: JSON.stringify({ error }) })
        .where(eq(proposals.id, id))
      return get(id)
    },

    async failPending(id, error) {
      const changed = await db
        .update(proposals)
        .set({ status: 'failed', result: JSON.stringify({ error }), decidedAt: now().toISOString() })
        .where(and(eq(proposals.id, id), eq(proposals.status, 'pending')))
        .returning({ id: proposals.id })
      return changed.length === 0 ? null : get(id)
    },

    async decidedSince(since) {
      const decided = and(
        inArray(proposals.status, ['confirmed', 'overridden', 'rejected', 'failed']),
        isNotNull(proposals.decidedAt),
        // At or after: one decided in the same millisecond is told twice rather than never.
        since === null ? undefined : gte(proposals.decidedAt, since)
      )
      const rows = await db.select().from(proposals).where(decided).orderBy(asc(proposals.decidedAt), asc(sql`rowid`))
      return rows.map(toProposal)
    }
  }
}
