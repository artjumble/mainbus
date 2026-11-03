import type { BoardTicket } from '../../shared/api'

/**
 * What the workspace rail shows for one workspace, from its tickets' stored state. `needsYou` counts the Needs you column.
 * `active` is true while an agent works or waits for a slot. While restart `recovering`, an agent paused only because its
 * process is gone (not by the user, not by a usage limit) counts too: recovery is about to resume it.
 */
export function railCounts(tickets: BoardTicket[], recovering: boolean): { active: boolean; needsYou: number } {
  const needsYou = tickets.filter((t) => t.state.column === 'needs_you').length
  const active = tickets.some(({ state }) => {
    if (state.agentStatus === 'working' || state.agentStatus === 'queued') return true
    return (
      recovering &&
      state.agentStatus === 'paused' &&
      state.canContinue &&
      !state.pausedByLimit &&
      !state.pausedByUser
    )
  })
  return { active, needsYou }
}
