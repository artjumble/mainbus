import { agentsMayAct } from '../../../shared/owner'
import type { BoardTicket } from '../store'

/** Which tickets the board shows by owner: the user's own, the agents', or all. */
export type OwnerFilter = 'mine' | 'agents' | 'all'

export const OWNER_FILTERS: { value: OwnerFilter; label: string }[] = [
  { value: 'mine', label: 'Mine' },
  { value: 'agents', label: "Agents'" },
  { value: 'all', label: 'All' }
]

const key = (workspaceId: string): string => `mainbus.ownerFilter.${workspaceId}`

/** The filter remembered for a workspace; 'all' when none is stored or storage can't be read. */
export function readOwnerFilter(workspaceId: string | undefined): OwnerFilter {
  if (!workspaceId) return 'all'
  try {
    const raw = localStorage.getItem(key(workspaceId))
    return raw === 'mine' || raw === 'agents' ? raw : 'all'
  } catch {
    return 'all'
  }
}

/** Remembers a workspace's filter; storage that can't be written is ignored. */
export function writeOwnerFilter(workspaceId: string | undefined, filter: OwnerFilter): void {
  if (!workspaceId) return
  try {
    localStorage.setItem(key(workspaceId), filter)
  } catch {
    // Only a preference: the filter still works.
  }
}

export function matchesOwner(ticket: Pick<BoardTicket, 'owner'>, filter: OwnerFilter): boolean {
  return filter === 'all' || (filter === 'mine') === !agentsMayAct(ticket)
}
