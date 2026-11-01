import { randomUUID } from 'node:crypto'
import { asc, eq, sql } from 'drizzle-orm'
import type { Workspace } from '../../shared/domain'
import type { Db } from '../db/open'
import { workspaces } from '../db/schema'
import { insertDefaultLineup } from './lineups'

export interface WorkspaceRepo {
  /** Creates the workspace and its default lineup. `name` is basename(repoPath) and `slug` is slugify(name). */
  create(repoPath: string, baseBranch: string, name: string, slug: string): Promise<Workspace>
  /** The MVP has at most one workspace. */
  get(): Promise<Workspace | null>
  setOpenPrOnReview(id: string, on: boolean): Promise<Workspace>
}

function toWorkspace(row: typeof workspaces.$inferSelect): Workspace {
  return {
    id: row.id,
    name: row.name,
    repoPath: row.repoPath,
    baseBranch: row.baseBranch,
    slug: row.slug,
    openPrOnReview: row.openPrOnReview
  }
}

export function createWorkspaceRepo(db: Db, now: () => Date): WorkspaceRepo {
  return {
    async create(repoPath, baseBranch, name, slug) {
      const workspace: Workspace = { id: randomUUID(), name, repoPath, baseBranch, slug, openPrOnReview: false }
      await db.insert(workspaces).values({ ...workspace, createdAt: now().toISOString() })
      await insertDefaultLineup(db, workspace.id)
      return workspace
    },

    async get() {
      const [row] = await db
        .select()
        .from(workspaces)
        .orderBy(asc(workspaces.createdAt), asc(sql`rowid`))
        .limit(1)
      return row ? toWorkspace(row) : null
    },

    async setOpenPrOnReview(id, on) {
      await db.update(workspaces).set({ openPrOnReview: on }).where(eq(workspaces.id, id))
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id))
      if (!row) throw new Error(`Workspace not found: ${id}`)
      return toWorkspace(row)
    }
  }
}
