import type { Db } from '../db/open'
import { createAllowRuleRepo, type AllowRuleRepo } from './allowRules'
import { createAttachmentRepo, type AttachmentRepo } from './attachments'
import { createCleanupRepo, type PendingCleanupRepo } from './cleanups'
import { createDecisionRepo, type DecisionRepo } from './decisions'
import { createHoldRepo, type HoldRepo } from './holds'
import { createLineupRepo, type LineupRepo } from './lineups'
import { createOrchestratorRepo, type OrchestratorRepo } from './orchestrator'
import { createProposalRepo, type ProposalRepo } from './proposals'
import { createRunRepo, type RunRepo } from './runs'
import { createSettingsRepo, type SettingsRepo } from './settings'
import { createStuckRepo, type StuckRepo } from './stuck'
import { createTicketRepo, type TicketRepo } from './tickets'
import { createWakeRepo, type WakeRepo } from './wakes'
import { createWorkspaceRepo, type WorkspaceRepo } from './workspaces'

export interface Repos {
  workspaces: WorkspaceRepo
  lineups: LineupRepo
  tickets: TicketRepo
  attachments: AttachmentRepo
  allowRules: AllowRuleRepo
  runs: RunRepo
  decisions: DecisionRepo
  cleanups: PendingCleanupRepo
  orchestrator: OrchestratorRepo
  proposals: ProposalRepo
  holds: HoldRepo
  stuck: StuckRepo
  wakes: WakeRepo
  settings: SettingsRepo
}

export function createRepos(db: Db, now: () => Date): Repos {
  return {
    workspaces: createWorkspaceRepo(db, now),
    lineups: createLineupRepo(db),
    tickets: createTicketRepo(db, now),
    attachments: createAttachmentRepo(db, now),
    allowRules: createAllowRuleRepo(db),
    runs: createRunRepo(db, now),
    decisions: createDecisionRepo(db, now),
    cleanups: createCleanupRepo(db, now),
    orchestrator: createOrchestratorRepo(db, now),
    proposals: createProposalRepo(db, now),
    holds: createHoldRepo(db, now),
    stuck: createStuckRepo(db, now),
    wakes: createWakeRepo(db, now),
    settings: createSettingsRepo(db)
  }
}
