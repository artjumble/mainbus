import { z } from 'zod'
import type { SetOwnerPayload, SetOwnerResult } from '../../shared/proposals'
import { REASON_MAX } from '../holds/holds'
import { parsePayload, ProposalInvalid, type ProposalKind } from './kind'

const proposeSchema = z.strictObject({
  ticket: z.number().int().positive(),
  owner: z.enum(['agent', 'human']),
  reason: z.string().trim().min(1, 'required').max(REASON_MAX, `must be at most ${REASON_MAX} characters`)
})

/**
 * Marking a ticket as the user's own (no agent works on it), or handing it to agents. The user can only confirm or reject.
 * Confirming goes through the engine's own setOwner, which refuses a ticket in Done or with a run open.
 */
export const setOwner: ProposalKind<SetOwnerPayload, SetOwnerResult> = {
  label: "change a ticket's owner",
  atomicWithResult: false,

  async propose(input, turn, ctx) {
    const p = parsePayload(proposeSchema, input)
    const ticket = await ctx.ticketByNumber(turn.workspaceId, p.ticket)
    if (!ticket) throw new ProposalInvalid(`ticket: there is no ticket #${p.ticket}`)
    if (ticket.manualColumn === 'done') {
      throw new ProposalInvalid(`ticket: #${ticket.number} is Done, so its owner can't be changed`)
    }
    if (ticket.owner === p.owner) {
      throw new ProposalInvalid(`owner: #${ticket.number} already belongs to ${p.owner === 'human' ? 'the user' : 'agents'}`)
    }
    if ((await ctx.activeRole(ticket)) !== null) {
      throw new ProposalInvalid(`ticket: #${ticket.number} has a run open; its owner can't be changed until the run is stopped`)
    }
    return { ticketId: ticket.id, number: ticket.number, title: ticket.title, owner: p.owner, reason: p.reason }
  },

  async execute(p, target, ctx) {
    const ws = await ctx.workspace(target.workspaceId)
    if (!ws || ws.id !== target.workspaceId) throw new Error('The workspace it was proposed for was removed')
    const ticket = await ctx.ticketByNumber(ws.id, p.number)
    if (!ticket || ticket.id !== p.ticketId) throw new Error(`Ticket #${p.number} no longer exists`)
    const saved = await ctx.setOwner(p.ticketId, p.owner)
    return { ticketId: p.ticketId, number: p.number, title: p.title, owner: saved.owner }
  },

  outcome(r) {
    return r.owner === 'human' ? `Marked #${r.number} ${JSON.stringify(r.title)} as the user's own.` : `Handed #${r.number} ${JSON.stringify(r.title)} to agents.`
  }
}
