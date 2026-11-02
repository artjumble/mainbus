import type { ProposalKindName } from '../../shared/proposals'
import { createTickets } from './createTickets'
import type { ProposalKind } from './kind'

/** Every kind of proposal. A new kind only adds an entry here. */
export const KINDS: Record<ProposalKindName, ProposalKind<any, any>> = {
  create_tickets: createTickets
}
