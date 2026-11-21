import { randomUUID } from 'node:crypto'
import { asc, eq, isNotNull, sql } from 'drizzle-orm'
import type { ImageRef } from '../../shared/attachments'
import type { Db } from '../db/open'
import { orchestratorQueue } from '../db/schema'

/** A message of the user waiting for the orchestrator's turn to end. */
export interface QueueRow {
  id: string
  text: string
  images: ImageRef[]
  /** The workspace ids the user picked from the @ list. */
  mentions: string[]
  queuedAt: string
  /** Why the queue is waiting for the user (the same for every row), or null. */
  heldReason: string | null
}

export interface OrchestratorQueueRepo {
  /** Every queued message, first to send first. */
  list(): Promise<QueueRow[]>
  /** Puts a message last. */
  add(input: { text: string; images: ImageRef[]; mentions: string[]; heldReason: string | null }): Promise<QueueRow>
  /** Changes a message's words; false when it is no longer queued. */
  setText(id: string, text: string): Promise<boolean>
  /** Takes a message out; the row, or null when it is no longer queued. */
  remove(id: string): Promise<QueueRow | null>
  /** Puts a message first; false when it is no longer queued. */
  moveToFront(id: string): Promise<boolean>
  /** Marks every queued message as waiting for the user. */
  holdAll(reason: string): Promise<void>
  /** Lets every queued message be sent again. */
  releaseAll(): Promise<void>
}

type Row = typeof orchestratorQueue.$inferSelect

function toRow(row: Row): QueueRow {
  return {
    id: row.id,
    text: row.text,
    images: JSON.parse(row.images) as ImageRef[],
    mentions: JSON.parse(row.mentions) as string[],
    queuedAt: row.queuedAt,
    heldReason: row.heldReason
  }
}

export function createOrchestratorQueueRepo(db: Db, now: () => Date): OrchestratorQueueRepo {
  const ordered = () => db.select().from(orchestratorQueue).orderBy(asc(orchestratorQueue.position), asc(sql`rowid`))
  const find = async (id: string): Promise<Row | undefined> =>
    (await db.select().from(orchestratorQueue).where(eq(orchestratorQueue.id, id)))[0]

  return {
    async list() {
      return (await ordered()).map(toRow)
    },

    async add({ text, images, mentions, heldReason }) {
      const [{ top }] = await db.select({ top: sql<number | null>`max(${orchestratorQueue.position})` }).from(orchestratorQueue)
      const row = {
        id: randomUUID(),
        position: (top ?? 0) + 1,
        text,
        images: JSON.stringify(images),
        mentions: JSON.stringify(mentions),
        queuedAt: now().toISOString(),
        heldReason
      }
      await db.insert(orchestratorQueue).values(row)
      return toRow(row)
    },

    async setText(id, text) {
      const updated = await db.update(orchestratorQueue).set({ text }).where(eq(orchestratorQueue.id, id)).returning({ id: orchestratorQueue.id })
      return updated.length > 0
    },

    async remove(id) {
      const row = await find(id)
      if (!row) return null
      await db.delete(orchestratorQueue).where(eq(orchestratorQueue.id, id))
      return toRow(row)
    },

    async moveToFront(id) {
      if (!(await find(id))) return false
      const [{ low }] = await db.select({ low: sql<number | null>`min(${orchestratorQueue.position})` }).from(orchestratorQueue)
      await db
        .update(orchestratorQueue)
        .set({ position: (low ?? 0) - 1 })
        .where(eq(orchestratorQueue.id, id))
      return true
    },

    async holdAll(reason) {
      await db.update(orchestratorQueue).set({ heldReason: reason })
    },

    async releaseAll() {
      await db.update(orchestratorQueue).set({ heldReason: null }).where(isNotNull(orchestratorQueue.heldReason))
    }
  }
}
