import type { BoardTicket } from '../../shared/api'

/**
 * What the workspace rail shows for one workspace, from its tickets' stored state. `needsYou` counts the Needs you column.
 * `active` is true while an agent works or waits for a slot. While restart `recovering`, an agent paused only because its
 * process is gone (not by the user, not by a usage limit) counts too: recovery is about to resume it.
 * The fleet counts are of agents: `working` work, `waiting` wait on you, `idle` are open but paused or queued.
 */
export function railCounts(
  tickets: BoardTicket[],
  recovering: boolean
): { active: boolean; needsYou: number; working: number; waiting: number; idle: number } {
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
  const count = (status: string): number => tickets.filter((t) => t.state.agentStatus === status).length
  return { active, needsYou, working: count('working'), waiting: count('waiting_on_you'), idle: count('paused') + count('queued') }
}
