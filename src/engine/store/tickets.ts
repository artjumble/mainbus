import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { Criterion, IntentEntry, NewTicketInput, PullRequest, Ticket, TicketPatch } from '../../shared/domain'
import type { Db } from '../db/open'
import { criteria, tickets } from '../db/schema'

export interface TicketRepo {
  create(input: NewTicketInput): Promise<Ticket>
  /** Creates the tickets in order, in one transaction: all of them, or none if one insert fails. */
  createMany(inputs: NewTicketInput[]): Promise<Ticket[]>
  get(id: string): Promise<Ticket>
  /** The ticket with this number in the workspace, or null. */
  byNumber(workspaceId: string, number: number): Promise<Ticket | null>
  list(workspaceId: string): Promise<Ticket[]>
  update(id: string, patch: TicketPatch): Promise<Ticket>
  /** Intent is append-only: this is the only way to add to it, and nothing edits or removes an entry. */
  appendIntent(id: string, text: string): Promise<Ticket>
  setManualColumn(id: string, column: 'backlog' | 'ready' | 'done'): Promise<Ticket>
  setWorktree(id: string, branch: string, path: string | null): Promise<Ticket>
  /** Records the ticket's pull request and clears any earlier failure. */
  setPr(id: string, pr: PullRequest): Promise<Ticket>
  setPrError(id: string, error: string | null): Promise<Ticket>
  /**
   * Ticks the criterion at `position` (never unticks). Returns it with `wasChecked` (whether it was already
   * ticked), or null when the ticket has no criterion there.
   */
  checkCriterion(id: string, position: number): Promise<(Criterion & { wasChecked: boolean }) | null>
}

type TicketRow = typeof tickets.$inferSelect

function toTicket(row: TicketRow, ticketCriteria: Criterion[]): Ticket {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    number: row.number,
    kind: 'change',
    title: row.title,
    intent: JSON.parse(row.intent) as IntentEntry[],
    spec: row.spec,
    criteria: ticketCriteria,
    labels: JSON.parse(row.labels) as string[],
    manualColumn: row.manualColumn as Ticket['manualColumn'],
    branch: row.branch,
    worktreePath: row.worktreePath,
    pr: row.prUrl !== null && row.prNumber !== null ? { url: row.prUrl, number: row.prNumber } : null,
    prError: row.prError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export function createTicketRepo(db: Db, now: () => Date): TicketRepo {
  async function criteriaFor(ticketId: string): Promise<Criterion[]> {
    return db
      .select({ position: criteria.position, text: criteria.text, checked: criteria.checked })
      .from(criteria)
      .where(eq(criteria.ticketId, ticketId))
      .orderBy(asc(criteria.position))
  }

  async function get(id: string): Promise<Ticket> {
    const [row] = await db.select().from(tickets).where(eq(tickets.id, id))
    if (!row) throw new Error(`Ticket not found: ${id}`)
    return toTicket(row, await criteriaFor(id))
  }

  /** Applies columns to a ticket (and stamps updatedAt) after checking that it exists. */
  async function patchRow(id: string, set: { [K in keyof typeof tickets.$inferInsert]?: (typeof tickets.$inferInsert)[K] | SQL }): Promise<void> {
    const [row] = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, id))
    if (!row) throw new Error(`Ticket not found: ${id}`)
    await db
      .update(tickets)
      .set({ ...set, updatedAt: now().toISOString() })
      .where(eq(tickets.id, id))
  }

  /** Inserts one ticket and its criteria through `q` (the database, or a transaction); returns its id. */
  async function insert(q: Pick<Db, 'insert'>, input: NewTicketInput): Promise<string> {
    const id = randomUUID()
    const at = now().toISOString()
    const intent: IntentEntry[] = [input.source ? { text: input.intent, at, source: input.source } : { text: input.intent, at }]
    await q.insert(tickets).values({
      id,
      workspaceId: input.workspaceId,
      // One statement, so the number is allocated atomically with the insert.
      number: sql`(select coalesce(max(${tickets.number}), 0) + 1 from ${tickets} where ${tickets.workspaceId} = ${input.workspaceId})`,
      kind: 'change',
      title: input.title,
      intent: JSON.stringify(intent),
      spec: input.spec,
      labels: JSON.stringify(input.labels),
      manualColumn: input.column,
      createdAt: at,
      updatedAt: at
    })
    if (input.criteria.length > 0) {
      await q
        .insert(criteria)
        .values(input.criteria.map((text, position) => ({ ticketId: id, position, text, checked: false })))
    }
    return id
  }

  return {
    async create(input) {
      return get(await insert(db, input))
    },

    async createMany(inputs) {
      const ids: string[] = []
      await db.transaction(async (tx) => {
        for (const input of inputs) ids.push(await insert(tx, input))
      })
      return Promise.all(ids.map(get))
    },

    get,

    async byNumber(workspaceId, number) {
      const [row] = await db
        .select()
        .from(tickets)
        .where(and(eq(tickets.workspaceId, workspaceId), eq(tickets.number, number)))
      return row ? toTicket(row, await criteriaFor(row.id)) : null
    },

    async list(workspaceId) {
      const rows = await db
        .select()
        .from(tickets)
        .where(eq(tickets.workspaceId, workspaceId))
        .orderBy(asc(tickets.number))
      if (rows.length === 0) return []
      const criteriaRows = await db
        .select()
        .from(criteria)
        .where(
          inArray(
            criteria.ticketId,
            rows.map((r) => r.id)
          )
        )
        .orderBy(asc(criteria.position))
      return rows.map((row) =>
        toTicket(
          row,
          criteriaRows
            .filter((c) => c.ticketId === row.id)
            .map(({ position, text, checked }) => ({ position, text, checked }))
        )
      )
    },

    async update(id, patch) {
      const set: Partial<typeof tickets.$inferInsert> = {}
      if (patch.title !== undefined) set.title = patch.title
      if (patch.spec !== undefined) set.spec = patch.spec
      if (patch.labels !== undefined) set.labels = JSON.stringify(patch.labels)
      await patchRow(id, set)
      if (patch.criteria !== undefined) {
        await db.delete(criteria).where(eq(criteria.ticketId, id))
        if (patch.criteria.length > 0) {
          await db.insert(criteria).values(
            patch.criteria.map((c, position) => ({ ticketId: id, position, text: c.text, checked: c.checked }))
          )
        }
      }
      return get(id)
    },

    async appendIntent(id, text) {
      const entry: IntentEntry = { text, at: now().toISOString() }
      // Appended inside SQLite so two concurrent appends cannot overwrite each other.
      await patchRow(id, { intent: sql`json_insert(${tickets.intent}, '$[#]', json(${JSON.stringify(entry)}))` })
      return get(id)
    },

    async setManualColumn(id, column) {
      await patchRow(id, { manualColumn: column })
      return get(id)
    },

    async setWorktree(id, branch, path) {
      await patchRow(id, { branch, worktreePath: path })
      return get(id)
    },

    async setPr(id, pr) {
      await patchRow(id, { prUrl: pr.url, prNumber: pr.number, prError: null })
      return get(id)
    },

    async setPrError(id, error) {
      await patchRow(id, { prError: error })
      return get(id)
    },

    async checkCriterion(id, position) {
      const where = and(eq(criteria.ticketId, id), eq(criteria.position, position))
      const [before] = await db.select({ checked: criteria.checked }).from(criteria).where(where)
      if (!before) return null
      // Only an unticked criterion changes, so two concurrent ticks record one tick between them.
      const [ticked] = await db
        .update(criteria)
        .set({ checked: true })
        .where(and(where, eq(criteria.checked, false)))
        .returning({ position: criteria.position, text: criteria.text, checked: criteria.checked })
      if (ticked) {
        await patchRow(id, {})
        return { ...ticked, wasChecked: false }
      }
      const [row] = await db
        .select({ position: criteria.position, text: criteria.text, checked: criteria.checked })
        .from(criteria)
        .where(where)
      return row ? { ...row, wasChecked: true } : null
    }
  }
}
