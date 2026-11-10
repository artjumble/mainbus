import { z } from 'zod'
import { mergePlanSentences } from '../../shared/merge'
import type { MergePayload, MergeResult } from '../../shared/proposals'
import { refusalText } from '../git/merge'
import { parsePayload, ProposalInvalid, type ProposalKind } from './kind'

const proposeSchema = z.strictObject({ ticket: z.number().int().positive() })

/**
 * Merging a ticket in Review: what the ticket view's Merge… does, with its defaults (move to Done, keep the GitHub
 * branch). The card states exactly what will happen; only the user's confirmation merges. There is nothing to override.
 */
export const merge: ProposalKind<MergePayload, MergeResult> = {
  label: 'merge a ticket',
  atomicWithResult: false,
  evidenceKey: 'reason',
  evidenceRequired: true,

  async propose(input, turn, ctx) {
    const p = parsePayload(proposeSchema, input)
    const ticket = await ctx.ticketByNumber(turn.workspaceId, p.ticket)
    if (!ticket) throw new ProposalInvalid(`ticket: there is no ticket #${p.ticket}`)
    const preview = await ctx.mergePreview(ticket.id)
    if (!preview.ok) throw new ProposalInvalid(`ticket: ${refusalText(preview)}`)
    return { ticketId: ticket.id, number: ticket.number, title: ticket.title, plan: preview.plan, moveToDone: true, deleteBranch: false }
  },

  async execute(p, target, ctx) {
    const ws = await ctx.workspace(target.workspaceId)
    if (!ws || ws.id !== target.workspaceId) throw new Error('The workspace it was proposed for was removed')
    const ticket = await ctx.ticketByNumber(ws.id, p.number)
    if (!ticket || ticket.id !== p.ticketId) throw new Error(`Ticket #${p.number} no longer exists`)
    // Fails, changing nothing, if what the user saw on the card is no longer what merging would do.
    const outcome = await ctx.mergeTicket(p.ticketId, {
      expect: p.plan,
      moveToDone: p.moveToDone,
      deleteBranch: p.deleteBranch,
      proposalId: target.proposalId
    })
    return { ticketId: p.ticketId, number: p.number, title: p.title, plan: outcome.plan, commit: outcome.commit, moved: outcome.moved }
  },

  outcome(r) {
    const what = mergePlanSentences(r.plan)[0]!
    const moved =
      r.moved === 'moved' ? ` #${r.number} is in Done.` : r.moved === 'not_asked' ? '' : ` #${r.number} could not move to Done and is still in Review.`
    return `Merged #${r.number} ${JSON.stringify(r.title)}: ${what}${moved}`
  }
}
