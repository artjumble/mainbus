/**
 * Tracks the changes the person made themselves, so the board can outline only what Mainbus changed. A command
 * counts as theirs while it runs and for a short grace after, since the board is read a moment later.
 */
export const OWN_CHANGE_GRACE_MS = 2000

const pending = new Map<string, number>()
const until = new Map<string, number>()

/** Runs a command the person started on a ticket, marking the ticket's changes as their own meanwhile. */
export async function asOwnChange<T>(ticketId: string, act: () => Promise<T>): Promise<T> {
  pending.set(ticketId, (pending.get(ticketId) ?? 0) + 1)
  try {
    return await act()
  } finally {
    const left = (pending.get(ticketId) ?? 1) - 1
    if (left <= 0) pending.delete(ticketId)
    else pending.set(ticketId, left)
    until.set(ticketId, Date.now() + OWN_CHANGE_GRACE_MS)
  }
}

export function isOwnChange(ticketId: string, now = Date.now()): boolean {
  return pending.has(ticketId) || now < (until.get(ticketId) ?? 0)
}

export function resetOwnChanges(): void {
  pending.clear()
  until.clear()
}
