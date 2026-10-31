import type { Db } from '../db/open'
import { createAllowRuleRepo, type AllowRuleRepo } from './allowRules'
import { createCleanupRepo, type PendingCleanupRepo } from './cleanups'
import { createDecisionRepo, type DecisionRepo } from './decisions'
import { createRoleRepo, type RoleRepo } from './roles'
import { createRunRepo, type RunRepo } from './runs'
import { createTicketRepo, type TicketRepo } from './tickets'
import { createWorkspaceRepo, type WorkspaceRepo } from './workspaces'

export interface Repos {
  workspaces: WorkspaceRepo
  roles: RoleRepo
  tickets: TicketRepo
  allowRules: AllowRuleRepo
  runs: RunRepo
  decisions: DecisionRepo
  cleanups: PendingCleanupRepo
}

export function createRepos(db: Db, now: () => Date): Repos {
  return {
    workspaces: createWorkspaceRepo(db, now),
    roles: createRoleRepo(db),
    tickets: createTicketRepo(db, now),
    allowRules: createAllowRuleRepo(db),
    runs: createRunRepo(db, now),
    decisions: createDecisionRepo(db, now),
    cleanups: createCleanupRepo(db, now)
  }
}
