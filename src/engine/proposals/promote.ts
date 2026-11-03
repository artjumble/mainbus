import { z } from 'zod'
import type { PromoteOverride, PromotePayload, PromoteResult } from '../../shared/proposals'
import { ticketFields } from '../tickets/validate'
import { parsePayload, ProposalInvalid, type ProposalKind } from './kind'

const proposeSchema = z.strictObject({
  ticket: z.number().int().positive(),
  title: ticketFields.title.optional(),
  spec: ticketFields.spec.optional()
})

const overrideSchema = z.strictObject({ title: ticketFields.title, spec: ticketFields.spec })

/**
 * Promoting an Investigate ticket's report into a Change ticket. The user can edit the title and spec; confirming
 * does what the ticket view's Promote does: the Change ticket is created in Ready with the report attached, and the
 * Investigate ticket moves to Done.
 */
export const promote: ProposalKind<PromotePayload, PromoteResult> = {
  label: 'promote an investigation',
  atomicWithResult: false,

  async propose(input, turn, ctx) {
    const p = parsePayload(proposeSchema, input)
    const ticket = await ctx.ticketByNumber(turn.workspaceId, p.ticket)
    if (!ticket) throw new ProposalInvalid(`ticket: there is no ticket #${p.ticket}`)
    const why = await ctx.whyNotPromotable(ticket)
    if (why !== null) throw new ProposalInvalid(`ticket: ${why}`)
    // A spec the orchestrator left out is drafted now, so the card shows it and Override can edit it.
    const drafted = p.spec === undefined ? await ctx.draftPromotionSpec(ticket) : null
    return {
      ticketId: ticket.id,
      number: ticket.number,
      fromTitle: ticket.title,
      title: p.title ?? ticket.title,
      spec: drafted ? drafted.spec : p.spec!,
      specSource: drafted ? (drafted.drafted ? 'summary' : 'report') : 'orchestrator'
    }
  },

  override(stored, input) {
    const o: PromoteOverride = parsePayload(overrideSchema, input)
    if (o.title.trim() === '') throw new ProposalInvalid('title: must not be blank')
    return { ...stored, title: o.title, spec: o.spec }
  },

  async execute(p, target, ctx) {
    const ws = await ctx.workspace()
    if (!ws || ws.id !== target.workspaceId) throw new Error('The workspace it was proposed for is no longer open')
    const ticket = await ctx.ticketByNumber(ws.id, p.number)
    if (!ticket || ticket.id !== p.ticketId) throw new Error(`Ticket #${p.number} no longer exists`)
    // The same guards as the button's Promote: a second confirm after one promoted it fails here.
    const created = await ctx.promoteTicket(p.ticketId, { title: p.title, spec: p.spec })
    return { ticketId: created.id, number: created.number, title: created.title, fromTicketId: p.ticketId, fromNumber: p.number }
  },

  outcome(r) {
    return `Promoted #${r.fromNumber} to #${r.number} ${JSON.stringify(r.title)} in Ready; #${r.fromNumber} is now Done.`
  }
}
