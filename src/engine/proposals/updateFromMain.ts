import { z } from 'zod'
import type { UpdateFromMainPayload, UpdateFromMainResult } from '../../shared/proposals'
import { parsePayload, ProposalInvalid, type ProposalKind } from './kind'

const proposeSchema = z.strictObject({ ticket: z.number().int().positive() })

/**
 * Updating a ticket's branch from main: what the ticket view's Update from main does. The ticket's open run, if it is
 * paused or waiting, ends as stopped, and an Implementer-only run merges the newest base, resolves conflicts, tests and
 * commits. There is nothing to override.
 */
export const updateFromMain: ProposalKind<UpdateFromMainPayload, UpdateFromMainResult> = {
  label: 'update a branch from main',
  atomicWithResult: false,
  evidenceKey: 'reason',
  evidenceRequired: true,

  async propose(input, turn, ctx) {
    const p = parsePayload(proposeSchema, input)
    const ticket = await ctx.ticketByNumber(turn.workspaceId, p.ticket)
    if (!ticket) throw new ProposalInvalid(`ticket: there is no ticket #${p.ticket}`)
    const why = await ctx.whyNotUpdatable(ticket)
    if (why !== null) throw new ProposalInvalid(`ticket: ${why}`)
    const fresh = ctx.freshnessOf(ticket)
    if (!fresh) throw new ProposalInvalid(`ticket: #${ticket.number} is not known to be behind main`)
    const active = await ctx.activeRole(ticket)
    return {
      ticketId: ticket.id,
      number: ticket.number,
      title: ticket.title,
      base: fresh.baseBranch,
      behind: fresh.behind,
      conflicts: fresh.conflicts,
      agentRunId: active?.agentRunId ?? null,
      role: active?.role ?? null
    }
  },

  async execute(p, target, ctx) {
    const ws = await ctx.workspace(target.workspaceId)
    if (!ws || ws.id !== target.workspaceId) throw new Error('The workspace it was proposed for was removed')
    const ticket = await ctx.ticketByNumber(ws.id, p.number)
    if (!ticket || ticket.id !== p.ticketId) throw new Error(`Ticket #${p.number} no longer exists`)
    // Fails, changing nothing, if the run the user saw has moved on (or one opened since).
    await ctx.updateFromMain(p.ticketId, p.agentRunId === null ? null : { agentRunId: p.agentRunId })
    const fresh = ctx.freshnessOf(ticket)
    return {
      ticketId: p.ticketId,
      number: p.number,
      title: p.title,
      base: fresh?.baseBranch ?? p.base,
      behind: fresh?.behind ?? p.behind,
      conflicts: fresh?.conflicts ?? p.conflicts
    }
  },

  outcome(r) {
    return (
      `Started an Update on #${r.number} ${JSON.stringify(r.title)}: the Implementer merges ${r.base}` +
      (r.conflicts.length > 0 ? ` and resolves conflicts in ${r.conflicts.join(', ')}` : '') +
      '. #' + r.number + ' goes to Review when it hands off.'
    )
  }
}
