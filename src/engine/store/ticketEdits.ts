import { randomUUID } from 'node:crypto'
import { asc, eq, and, isNull } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { EditedField, EditedValues, IntentEntry, TicketEdit, TicketPatch } from '../../shared/domain'
import type { Db } from '../db/open'
import { ticketEdits, tickets } from '../db/schema'
import { appendIntentStatement, patchStatements, type TicketRepo } from './tickets'

export interface NewTicketEdit {
  ticketId: string
  workspaceId: string
  orchestratorRunId: string
  /** The changes, already checked; criteria with their ticks. */
  patch: TicketPatch
  fields: EditedField[]
  before: EditedValues
  after: EditedValues
  /** The user's messages to append to the ticket's intent, verbatim. */
  userWords: string[]
}

/** Why an Undo found the ticket changed: the engine words the refusal from the ticket's number. */
export class EditChangedError extends Error {
  constructor(readonly number: number) {
    super(`#${number} has changed since this edit, so it can't be undone`)
  }
}

export interface TicketEditRepo {
  /**
   * Applies the edit in one batch: the same statements as `ticket.update` and `ticket.appendIntent` (one timestamp for the
   * ticket's updatedAt and for each appended entry), and the record of it. All of it or none.
   */
  apply(input: NewTicketEdit): Promise<TicketEdit>
  /**
   * Puts every changed field back as it was and removes the intent entries this edit appended: the only place intent
   * entries are ever removed. Throws EditChangedError unless the ticket is exactly as the edit left it (not updated
   * since, its intent still ending with the entries the edit appended), and refuses an edit already undone.
   */
  undo(edit: TicketEdit): Promise<TicketEdit>
  get(id: string): Promise<TicketEdit>
  /** Every edit, oldest first. */
  listAll(): Promise<TicketEdit[]>
  /** The edits of the workspace's tickets, oldest first. */
  listForWorkspace(workspaceId: string): Promise<TicketEdit[]>
}

function toEdit(row: typeof ticketEdits.$inferSelect, number: number): TicketEdit {
  return {
    id: row.id,
    ticketId: row.ticketId,
    workspaceId: row.workspaceId,
    number,
    at: row.at,
    fields: JSON.parse(row.fields) as EditedField[],
    before: JSON.parse(row.before) as EditedValues,
    after: JSON.parse(row.after) as EditedValues,
    intentAdded: JSON.parse(row.intentAdded) as IntentEntry[],
    ticketUpdatedAt: row.ticketUpdatedAt,
    undoneAt: row.undoneAt
  }
}

export function createTicketEditRepo(db: Db, now: () => Date, ticketRepo: TicketRepo): TicketEditRepo {
  const select = () =>
    db.select({ edit: ticketEdits, number: tickets.number }).from(ticketEdits).innerJoin(tickets, eq(tickets.id, ticketEdits.ticketId))

  async function get(id: string): Promise<TicketEdit> {
    const [row] = await select().where(eq(ticketEdits.id, id))
    if (!row) throw new Error(`Ticket edit not found: ${id}`)
    return toEdit(row.edit, row.number)
  }

  return {
    get,

    async apply(input) {
      const ticket = await ticketRepo.get(input.ticketId)
      const at = now().toISOString()
      const intentAdded: IntentEntry[] = input.userWords.map((text) => ({ text, at }))
      const id = randomUUID()
      const statements: BatchItem<'sqlite'>[] = [
        ...patchStatements(db, input.ticketId, input.patch, at),
        ...intentAdded.map((entry) => appendIntentStatement(db, input.ticketId, entry)),
        db.insert(ticketEdits).values({
          id,
          ticketId: input.ticketId,
          workspaceId: input.workspaceId,
          orchestratorRunId: input.orchestratorRunId,
          at,
          fields: JSON.stringify(input.fields),
          before: JSON.stringify(input.before),
          after: JSON.stringify(input.after),
          intentAdded: JSON.stringify(intentAdded),
          ticketUpdatedAt: at
        })
      ]
      const [first, ...rest] = statements
      await db.batch([first!, ...rest])
      return toEdit((await db.select().from(ticketEdits).where(eq(ticketEdits.id, id)))[0]!, ticket.number)
    },

    async undo(edit) {
      if (edit.undoneAt !== null) throw new Error(`The edit of #${edit.number} is already undone`)
      const ticket = await ticketRepo.get(edit.ticketId)
      const added = edit.intentAdded
      const tail = ticket.intent.slice(ticket.intent.length - added.length)
      const unchanged =
        ticket.updatedAt === edit.ticketUpdatedAt &&
        ticket.intent.length >= added.length &&
        JSON.stringify(tail) === JSON.stringify(added)
      if (!unchanged) throw new EditChangedError(edit.number)
      const at = now().toISOString()
      const patch: TicketPatch = {
        ...(edit.before.title !== undefined ? { title: edit.before.title } : {}),
        ...(edit.before.spec !== undefined ? { spec: edit.before.spec } : {}),
        ...(edit.before.criteria !== undefined ? { criteria: edit.before.criteria } : {}),
        ...(edit.before.labels !== undefined ? { labels: edit.before.labels } : {})
      }
      const statements: BatchItem<'sqlite'>[] = [
        ...patchStatements(db, edit.ticketId, patch, at),
        // Exactly the entries this edit appended: the check above found them at the end.
        ...(added.length > 0
          ? [db.update(tickets).set({ intent: JSON.stringify(ticket.intent.slice(0, ticket.intent.length - added.length)) }).where(eq(tickets.id, edit.ticketId))]
          : []),
        db
          .update(ticketEdits)
          .set({ undoneAt: at })
          .where(and(eq(ticketEdits.id, edit.id), isNull(ticketEdits.undoneAt)))
      ]
      const [first, ...rest] = statements
      await db.batch([first!, ...rest])
      return get(edit.id)
    },

    async listAll() {
      return (await select().orderBy(asc(ticketEdits.at))).map((r) => toEdit(r.edit, r.number))
    },

    async listForWorkspace(workspaceId) {
      return (await select().where(eq(ticketEdits.workspaceId, workspaceId)).orderBy(asc(ticketEdits.at))).map((r) => toEdit(r.edit, r.number))
    }
  }
}
