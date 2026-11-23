import type { Ticket } from './domain'

/** Whether agents may act on the ticket (start a role, queue a review, wake the orchestrator about it). False for the user's own tickets. */
export function agentsMayAct(ticket: Pick<Ticket, 'owner'>): boolean {
  return ticket.owner === 'agent'
}

/** The one wording every refusal to act on a human-owned ticket uses. */
export function yoursText(number: number): string {
  return `#${number} is yours; the user has to hand it to agents first`
}
