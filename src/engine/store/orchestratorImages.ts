import { eq, inArray } from 'drizzle-orm'
import type { ImageMime, OrchestratorImage } from '../../shared/attachments'
import type { Db } from '../db/open'
import { orchestratorImages } from '../db/schema'

export interface OrchestratorImageRepo {
  /** Records images whose files are already written, all of them or none; `id` is the one in each file's name. */
  addMany(images: Omit<OrchestratorImage, 'createdAt'>[]): Promise<OrchestratorImage[]>
  get(id: string): Promise<OrchestratorImage | null>
  /** Every image's filename: a new one must not take one of them (ignoring case). */
  filenames(): Promise<string[]>
  /** The images with these ids that exist, in no particular order. */
  byIds(ids: string[]): Promise<OrchestratorImage[]>
}

type Row = typeof orchestratorImages.$inferSelect

function toImage(row: Row): OrchestratorImage {
  return { ...row, mime: row.mime as ImageMime }
}

export function createOrchestratorImageRepo(db: Db, now: () => Date): OrchestratorImageRepo {
  return {
    async addMany(images) {
      if (images.length === 0) return []
      const at = now().toISOString()
      const rows = images.map((i) => ({ ...i, createdAt: at }))
      await db.insert(orchestratorImages).values(rows)
      return rows
    },

    async get(id) {
      const [row] = await db.select().from(orchestratorImages).where(eq(orchestratorImages.id, id))
      return row ? toImage(row) : null
    },

    async filenames() {
      const rows = await db.select({ filename: orchestratorImages.filename }).from(orchestratorImages)
      return rows.map((r) => r.filename)
    },

    async byIds(ids) {
      if (ids.length === 0) return []
      return (await db.select().from(orchestratorImages).where(inArray(orchestratorImages.id, ids))).map(toImage)
    }
  }
}
