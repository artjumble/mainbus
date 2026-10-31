import { randomUUID } from 'node:crypto'
import { asc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { Criterion, IntentEntry, NewTicketInput, Ticket, TicketPatch } from '../../shared/domain'
import type { Db } from '../db/open'
import { criteria, tickets } from '../db/schema'

export interface TicketRepo {
  create(input: NewTicketInput): Promise<Ticket>
  get(id: string): Promise<Ticket>
  list(workspaceId: string): Promise<Ticket[]>
  update(id: string, patch: TicketPatch): Promise<Ticket>
  /** Intent is append-only: this is the only way to add to it, and nothing edits or removes an entry. */
  appendIntent(id: string, text: string): Promise<Ticket>
  setManualColumn(id: string, column: 'backlog' | 'ready' | 'done'): Promise<Ticket>
  setWorktree(id: string, branch: string, path: string | null): Promise<Ticket>
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

  return {
    async create(input) {
      const id = randomUUID()
      const at = now().toISOString()
      const intent: IntentEntry[] = [{ text: input.intent, at }]
      await db.insert(tickets).values({
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
        await db
          .insert(criteria)
          .values(input.criteria.map((text, position) => ({ ticketId: id, position, text, checked: false })))
      }
      return get(id)
    },

    get,

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
    }
  }
}
