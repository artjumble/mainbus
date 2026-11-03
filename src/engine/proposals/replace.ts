import { z } from 'zod'
import type { Effort } from '../../shared/domain'
import { EFFORTS, EXTRA_INSTRUCTIONS_MAX, modelAllowed } from '../../shared/models'
import type { ReplacePayload, ReplaceResult } from '../../shared/proposals'
import { firedAgainAfterRedirect } from '../stuck/ladder'
import { parsePayload, ProposalInvalid, type ProposalKind } from './kind'

export const REASON_MAX = 2_000

const proposeSchema = z.strictObject({
  ticket: z.number().int().positive(),
  reason: z.string().trim().min(1, 'required').max(REASON_MAX, `must be at most ${REASON_MAX} characters`)
})

const overrideSchema = z.strictObject({
  model: z.string().min(1, 'required'),
  effort: z.enum(EFFORTS as [Effort, ...Effort[]]),
  extraInstructions: z.string().max(EXTRA_INSTRUCTIONS_MAX, `must be at most ${EXTRA_INSTRUCTIONS_MAX} characters`).default('')
})

/** Trimmed, or null when blank. */
function extraText(text: string): string | null {
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Step two of the recovery ladder: replacing a stuck agent with a fresh one that starts from a summary of what the
 * first one did. The orchestrator may propose it only for a role whose open stuck episode was redirected and has
 * fired again. The user's own Replace… button makes the same proposal at any time (origin 'button'), with no
 * episode needed. Confirming ends the old run as replaced and starts the role again in the same worktree and
 * ticket run; the new run's model, effort and extra instructions are the card's, as overridden.
 */
export const replace: ProposalKind<ReplacePayload, ReplaceResult> = {
  label: 'replace a stuck agent',
  atomicWithResult: false,
  evidenceRequired: true,

  async propose(input, turn, ctx) {
    const p = parsePayload(proposeSchema, input)
    const ticket = await ctx.ticketByNumber(turn.workspaceId, p.ticket)
    if (!ticket) throw new ProposalInvalid(`ticket: there is no ticket #${p.ticket}`)
    const active = await ctx.activeRole(ticket)
    if (!active) throw new ProposalInvalid(`ticket: #${ticket.number} has no active role to replace`)
    // The user's own button needs no episode: it is their decision, not the orchestrator's.
    const byUser = turn.origin === 'button'
    let episodeId: string | null = null
    let episodeEvidence: string[] = []
    if (!byUser) {
      const who = `the ${active.role} on #${ticket.number}`
      const episode = await ctx.openStuckEpisode(active.agentRunId)
      if (!episode) throw new ProposalInvalid(`ticket: ${who} has no open stuck episode, so there is nothing to replace`)
      if (episode.redirectedAt === null) throw new ProposalInvalid(`ticket: ${who} has not been redirected yet; propose a redirect first`)
      if (!firedAgainAfterRedirect(episode)) {
        throw new ProposalInvalid(`ticket: ${who} was redirected and has not fired again since; give the redirect time before proposing a replacement`)
      }
      episodeId = episode.id
      episodeEvidence = episode.evidence
    }
    return {
      ticketId: ticket.id,
      number: ticket.number,
      title: ticket.title,
      agentRunId: active.agentRunId,
      role: active.role,
      episodeId,
      episodeEvidence,
      reason: p.reason,
      model: active.model,
      effort: active.effort,
      extraInstructions: null
    }
  },

  override(stored, input) {
    const o = parsePayload(overrideSchema, input)
    if (!modelAllowed({ model: stored.model }, o.model)) throw new ProposalInvalid('model: unknown model')
    return { ...stored, model: o.model, effort: o.effort, extraInstructions: extraText(o.extraInstructions) }
  },

  async execute(p, target, ctx) {
    const ws = await ctx.workspace(target.workspaceId)
    if (!ws || ws.id !== target.workspaceId) throw new Error('The workspace it was proposed for was removed')
    const ticket = await ctx.ticketByNumber(ws.id, p.number)
    if (!ticket || ticket.id !== p.ticketId) throw new Error(`Ticket #${p.number} no longer exists`)
    const nothing = 'Nothing was replaced.'
    const active = await ctx.activeRole(ticket)
    if (!active || active.agentRunId !== p.agentRunId) {
      const now = active ? `now: the ${active.role}` : 'the run has ended'
      throw new Error(`#${p.number} has moved on since this was proposed: the ${p.role} is no longer its active role (${now}). ${nothing}`)
    }
    if (p.episodeId !== null) {
      const episode = await ctx.openStuckEpisode(p.agentRunId)
      if (!episode || episode.id !== p.episodeId) throw new Error(`The ${p.role} on #${p.number} is no longer stuck: that episode has closed. ${nothing}`)
    }
    await ctx.replaceTicket(p.ticketId, { agentRunId: p.agentRunId }, {
      model: p.model,
      effort: p.effort,
      extraInstructions: p.extraInstructions,
      proposalId: target.proposalId,
      // An episode is absent exactly when the user's Replace… button made the proposal.
      suggestedBy: p.episodeId === null ? 'user' : 'orchestrator'
    })
    return { ticketId: p.ticketId, number: p.number, title: p.title, role: p.role, model: p.model, effort: p.effort }
  },

  outcome(r) {
    return `Replaced the ${r.role} on #${r.number} ${JSON.stringify(r.title)}: its agent ended and a fresh ${r.role} (${r.model}, ${r.effort}) took over from a summary of its log.`
  }
}
