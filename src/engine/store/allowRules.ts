import { randomUUID } from 'node:crypto'
import { asc, eq, sql } from 'drizzle-orm'
import type { AllowRule } from '../../shared/domain'
import type { Db } from '../db/open'
import { allowRules } from '../db/schema'

export interface AllowRuleRepo {
  list(workspaceId: string): Promise<AllowRule[]>
  add(rule: Omit<AllowRule, 'id'>): Promise<AllowRule>
  remove(id: string): Promise<void>
}

export function createAllowRuleRepo(db: Db): AllowRuleRepo {
  return {
    async list(workspaceId) {
      return db
        .select()
        .from(allowRules)
        .where(eq(allowRules.workspaceId, workspaceId))
        .orderBy(asc(sql`rowid`))
    },

    async add(rule) {
      const created: AllowRule = { id: randomUUID(), ...rule }
      await db.insert(allowRules).values(created)
      return created
    },

    async remove(id) {
      await db.delete(allowRules).where(eq(allowRules.id, id))
    }
  }
}
