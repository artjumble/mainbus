import type { AgentStatus, LineupRole, RoleStatus, StripRole } from '../../shared/domain'
import type { AgentRunRow } from '../store/runs'

export interface StripInput {
  /** The latest ticket run's roles, in order; before the first run, the workspace lineup. */
  roles: Pick<LineupRole, 'id' | 'name'>[]
  /** The agent runs of the latest ticket run, oldest first; none before the first run. */
  runs: Pick<AgentRunRow, 'id' | 'roleId' | 'endReason'>[]
  /** The ticket's latest agent run, or null before the first run. */
  latestRunId: string | null
  /** The ticket's agent status, which the latest run's open role takes. */
  agentStatus: AgentStatus | null
}

const ENDED: Record<NonNullable<AgentRunRow['endReason']>, RoleStatus> = {
  handoff: 'handed_off',
  // Waiting for the earlier role it handed back to.
  handed_back: 'handed_off',
  failed: 'failed',
  stopped: 'stopped'
}

/**
 * The lineup strip: each role of the run with where it stands, from its last agent run. Only the latest
 * agent run, while open, is active; it takes the ticket's agent status. Another open run is one handing off
 * right now (the next role's run exists before the previous one ends), so it counts as handed off.
 */
export function lineupStrip({ roles, runs, latestRunId, agentStatus }: StripInput): StripRole[] {
  return roles.map((role) => {
    const run = runs.findLast((r) => r.roleId === role.id)
    const active = run !== undefined && run.id === latestRunId && run.endReason === null
    let status: RoleStatus
    if (!run) status = 'not_started'
    else if (run.endReason !== null) status = ENDED[run.endReason]
    else if (active) status = openStatus(agentStatus)
    else status = 'handed_off'
    return { id: role.id, name: role.name, status, active }
  })
}

function openStatus(agentStatus: AgentStatus | null): RoleStatus {
  if (agentStatus === 'working' || agentStatus === 'queued') return 'working'
  if (agentStatus === 'waiting_on_you') return 'waiting_on_you'
  return 'paused'
}
