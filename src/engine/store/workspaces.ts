import { randomUUID } from 'node:crypto'
import { asc, sql } from 'drizzle-orm'
import type { Workspace } from '../../shared/domain'
import type { Db } from '../db/open'
import { roles, workspaces } from '../db/schema'
import { defaultRole } from './roles'

export interface WorkspaceRepo {
  /** Creates the workspace and its default role. `name` is basename(repoPath) and `slug` is slugify(name). */
  create(repoPath: string, baseBranch: string, name: string, slug: string): Promise<Workspace>
  /** The MVP has at most one workspace. */
  get(): Promise<Workspace | null>
}

function toWorkspace(row: typeof workspaces.$inferSelect): Workspace {
  return { id: row.id, name: row.name, repoPath: row.repoPath, baseBranch: row.baseBranch, slug: row.slug }
}

export function createWorkspaceRepo(db: Db, now: () => Date): WorkspaceRepo {
  return {
    async create(repoPath, baseBranch, name, slug) {
      const workspace: Workspace = { id: randomUUID(), name, repoPath, baseBranch, slug }
      await db.insert(workspaces).values({ ...workspace, createdAt: now().toISOString() })
      await db.insert(roles).values(defaultRole(workspace.id))
      return workspace
    },

    async get() {
      const [row] = await db
        .select()
        .from(workspaces)
        .orderBy(asc(workspaces.createdAt), asc(sql`rowid`))
        .limit(1)
      return row ? toWorkspace(row) : null
    }
  }
}
