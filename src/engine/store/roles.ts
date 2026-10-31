import { eq } from 'drizzle-orm'
import type { Effort, Phase, Role } from '../../shared/domain'
import type { Db } from '../db/open'
import { roles } from '../db/schema'

export type RolePatch = Partial<Pick<Role, 'instructions' | 'model' | 'effort'>>

export interface RoleRepo {
  get(workspaceId: string): Promise<Role>
  update(workspaceId: string, patch: RolePatch): Promise<Role>
}

/** The role every new workspace starts with. */
export function defaultRole(workspaceId: string): Role {
  return {
    workspaceId,
    name: 'Implementer',
    instructions: 'Make the change and its tests. Commit your work on the branch before handing off.',
    activePhase: 'implementing',
    toolProfile: 'edit',
    model: null,
    effort: null
  }
}

function toRole(row: typeof roles.$inferSelect): Role {
  return {
    workspaceId: row.workspaceId,
    name: row.name,
    instructions: row.instructions,
    activePhase: row.activePhase as Phase,
    toolProfile: row.toolProfile as Role['toolProfile'],
    model: row.model,
    effort: row.effort as Effort | null
  }
}

export function createRoleRepo(db: Db): RoleRepo {
  async function get(workspaceId: string): Promise<Role> {
    const [row] = await db.select().from(roles).where(eq(roles.workspaceId, workspaceId))
    if (!row) throw new Error(`No role for workspace ${workspaceId}`)
    return toRole(row)
  }

  return {
    get,
    async update(workspaceId, patch) {
      const set: Partial<typeof roles.$inferInsert> = {}
      if (patch.instructions !== undefined) set.instructions = patch.instructions
      if (patch.model !== undefined) set.model = patch.model
      if (patch.effort !== undefined) set.effort = patch.effort
      // Check it exists first: drizzle rejects an empty .set(), and a missing role should throw either way.
      const current = await get(workspaceId)
      if (Object.keys(set).length === 0) return current
      await db.update(roles).set(set).where(eq(roles.workspaceId, workspaceId))
      return get(workspaceId)
    }
  }
}
