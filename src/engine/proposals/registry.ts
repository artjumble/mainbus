import type { ProposalKindName } from '../../shared/proposals'
import { answer } from './answer'
import { createTickets } from './createTickets'
import { hold } from './hold'
import type { ProposalKind } from './kind'
import { redirect } from './redirect'
import { promote } from './promote'
import { replace } from './replace'
import { pause, skip, stop } from './roleControls'
import { startLineup } from './startLineup'
import { updateFromMain } from './updateFromMain'

/** Every kind of proposal. A new kind only adds an entry here. */
export const KINDS: Record<ProposalKindName, ProposalKind<any, any>> = {
  create_tickets: createTickets,
  start_lineup: startLineup,
  pause,
  stop,
  skip,
  hold,
  answer,
  redirect,
  replace,
  promote,
  update_from_main: updateFromMain
}
