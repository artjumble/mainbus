/** What a ticket's blockers must satisfy, checked before any link is stored. */
export interface TicketRef {
  id: string
  number: number
}

export type BlockerCheck = { ok: true; ids: string[] } | { ok: false; reason: string }

/**
 * Checks the new blockers of `ticketId` (null for a ticket not created yet). `workspaceTickets` are the tickets of its
 * workspace; `edges` maps a ticket id to the ids that block it now. Refuses a self-link, a ticket that isn't in the
 * workspace, and a cycle; a repeated blocker is kept once.
 */
export function checkBlockers(
  ticketId: string | null,
  blockerIds: string[],
  workspaceTickets: TicketRef[],
  edges: Map<string, string[]>
): BlockerCheck {
  const byId = new Map(workspaceTickets.map((t) => [t.id, t]))
  const numberOf = (id: string) => `#${byId.get(id)?.number ?? '?'}`
  const ids = [...new Set(blockerIds)]
  for (const id of ids) {
    if (id === ticketId) return { ok: false, reason: `${numberOf(id)} can't be blocked by itself` }
    if (!byId.has(id)) return { ok: false, reason: 'A blocker must be a ticket in the same workspace' }
  }
  if (ticketId !== null) {
    for (const id of ids) {
      // Walk what blocks the blocker: reaching this ticket again closes a loop.
      const seen = new Set<string>()
      const stack = [id]
      while (stack.length > 0) {
        const at = stack.pop()!
        if (seen.has(at)) continue
        seen.add(at)
        for (const next of edges.get(at) ?? []) {
          if (next === ticketId) {
            return {
              ok: false,
              reason:
                at === id
                  ? `${numberOf(id)} is already blocked by ${numberOf(ticketId)}, so ${numberOf(ticketId)} can't be blocked by ${numberOf(id)}`
                  : `${numberOf(ticketId)} can't be blocked by ${numberOf(id)}: that would make a loop`
            }
          }
          stack.push(next)
        }
      }
    }
  }
  return { ok: true, ids }
}
