import { randomUUID } from 'node:crypto'
import { and, asc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Proposal, ProposalKindName } from '../../shared/proposals'
import type { Db } from '../db/open'
import { proposals } from '../db/schema'

export interface NewProposal {
  workspaceId: string
  orchestratorRunId: string
  kind: ProposalKindName
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
  /** Carrying out a claimed proposal threw: it is failed, with the error as its result. */
  fail(id: string, error: string): Promise<Proposal>
  /** The proposals decided at or after `since` (every decided one when null), oldest decision first. */
  decidedSince(since: string | null): Promise<Proposal[]>
}

function toProposal(row: typeof proposals.$inferSelect): Proposal {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    orchestratorRunId: row.orchestratorRunId,
    kind: row.kind as ProposalKindName,
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

    async fail(id, error) {
      await db
        .update(proposals)
        .set({ status: 'failed', result: JSON.stringify({ error }) })
        .where(eq(proposals.id, id))
      return get(id)
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
