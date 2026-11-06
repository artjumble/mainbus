import { asc, eq, inArray } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Attachment, ImageMime } from '../../shared/attachments'
import type { Db } from '../db/open'
import { ticketAttachments, tickets } from '../db/schema'

export interface AttachmentRepo {
  /** Records an attachment whose file is already written; `id` is the one in the file's name. */
  add(a: Omit<Attachment, 'createdAt'>): Promise<Attachment>
  /** The insert of `add`, to run in a batch with the ticket's own inserts. */
  addStatement(a: Omit<Attachment, 'createdAt'>): BatchItem<'sqlite'>
  get(id: string): Promise<Attachment | null>
  /** The ticket's attachments, oldest first. */
  list(ticketId: string): Promise<Attachment[]>
  /** The attachments of every ticket of the workspace, oldest first. */
  listForWorkspace(workspaceId: string): Promise<Attachment[]>
  /** Removes the row; true when there was one. */
  remove(id: string): Promise<boolean>
  /** Removes the rows of every ticket of the workspace. */
  removeForWorkspace(workspaceId: string): Promise<void>
}

type Row = typeof ticketAttachments.$inferSelect

function toAttachment(row: Row): Attachment {
  return { ...row, mime: row.mime as ImageMime }
}

export function createAttachmentRepo(db: Db, now: () => Date): AttachmentRepo {
  const ofWorkspace = (workspaceId: string) => db.select({ id: tickets.id }).from(tickets).where(eq(tickets.workspaceId, workspaceId))

  return {
    async add(a) {
      const row = { ...a, createdAt: now().toISOString() }
      await db.insert(ticketAttachments).values(row)
      return row
    },

    addStatement(a) {
      return db.insert(ticketAttachments).values({ ...a, createdAt: now().toISOString() })
    },

    async get(id) {
      const [row] = await db.select().from(ticketAttachments).where(eq(ticketAttachments.id, id))
      return row ? toAttachment(row) : null
    },

    async list(ticketId) {
      const rows = await db
        .select()
        .from(ticketAttachments)
        .where(eq(ticketAttachments.ticketId, ticketId))
        .orderBy(asc(ticketAttachments.createdAt), asc(ticketAttachments.id))
      return rows.map(toAttachment)
    },

    async listForWorkspace(workspaceId) {
      const rows = await db
        .select()
        .from(ticketAttachments)
        .where(inArray(ticketAttachments.ticketId, ofWorkspace(workspaceId)))
        .orderBy(asc(ticketAttachments.createdAt), asc(ticketAttachments.id))
      return rows.map(toAttachment)
    },

    async remove(id) {
      const removed = await db.delete(ticketAttachments).where(eq(ticketAttachments.id, id)).returning({ id: ticketAttachments.id })
      return removed.length > 0
    },

    async removeForWorkspace(workspaceId) {
      await db.delete(ticketAttachments).where(inArray(ticketAttachments.ticketId, ofWorkspace(workspaceId)))
    }
  }
}
