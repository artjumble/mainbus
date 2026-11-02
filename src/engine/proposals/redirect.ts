import { z } from 'zod'
import type { RedirectPayload, RedirectResult } from '../../shared/proposals'
import { parsePayload, ProposalInvalid, type ProposalKind } from './kind'

export const MESSAGE_MAX = 2_000

const message = z.string().trim().min(1, 'required').max(MESSAGE_MAX, `must be at most ${MESSAGE_MAX} characters`)

const proposeSchema = z.strictObject({ ticket: z.number().int().positive(), message })

const overrideSchema = z.strictObject({ message })

const ALREADY_REDIRECTED = 'its stuck episode has already been redirected once; propose a replacement instead'

/**
 * Step one of the recovery ladder: one corrective message to a stuck agent. Valid only while its run has an open
 * stuck episode that hasn't been redirected. Confirming interrupts the agent's turn (as Pause does, but keeping
 * its session) and sends the message, as edited, as its next one.
 */
export const redirect: ProposalKind<RedirectPayload, RedirectResult> = {
  label: 'redirect a stuck agent',
  atomicWithResult: false,
  evidenceRequired: true,

  async propose(input, turn, ctx) {
    const p = parsePayload(proposeSchema, input)
    const ticket = await ctx.ticketByNumber(turn.workspaceId, p.ticket)
    if (!ticket) throw new ProposalInvalid(`ticket: there is no ticket #${p.ticket}`)
    const active = await ctx.activeRole(ticket)
    if (!active) throw new ProposalInvalid(`ticket: #${ticket.number} has no active role to redirect`)
    const episode = await ctx.openStuckEpisode(active.agentRunId)
    if (!episode) throw new ProposalInvalid(`ticket: the ${active.role} on #${ticket.number} has no open stuck episode, so there is nothing to redirect`)
    if (episode.redirectedAt !== null) throw new ProposalInvalid(`ticket: the ${active.role} on #${ticket.number}: ${ALREADY_REDIRECTED}`)
    return {
      ticketId: ticket.id,
      number: ticket.number,
      title: ticket.title,
      agentRunId: active.agentRunId,
      episodeId: episode.id,
      role: active.role,
      episodeEvidence: episode.evidence,
      message: p.message
    }
  },

  override(stored, input) {
    return { ...stored, message: parsePayload(overrideSchema, input).message }
  },

  async execute(p, target, ctx) {
    const ws = await ctx.workspace()
    if (!ws || ws.id !== target.workspaceId) throw new Error('The workspace it was proposed for is no longer open')
    const ticket = await ctx.ticketByNumber(ws.id, p.number)
    if (!ticket || ticket.id !== p.ticketId) throw new Error(`Ticket #${p.number} no longer exists`)
    const nothing = 'Nothing was interrupted.'
    const active = await ctx.activeRole(ticket)
    if (!active || active.agentRunId !== p.agentRunId) {
      const now = active ? `now: the ${active.role}` : 'the run has ended'
      throw new Error(`#${p.number} has moved on since this was proposed: the ${p.role} is no longer its active role (${now}). ${nothing}`)
    }
    const episode = await ctx.openStuckEpisode(p.agentRunId)
    if (!episode || episode.id !== p.episodeId) {
      throw new Error(`The ${p.role} on #${p.number} is no longer stuck: that episode has closed. ${nothing}`)
    }
    if (episode.redirectedAt !== null) throw new Error(`The ${p.role} on #${p.number}: ${ALREADY_REDIRECTED}. ${nothing}`)
    if (active.agentStatus !== 'working') throw new Error(`The ${p.role} on #${p.number} is not working now (${active.agentStatus}). ${nothing}`)
    await ctx.redirectTicket(p.ticketId, { agentRunId: p.agentRunId, episodeId: p.episodeId }, p.message)
    return { ticketId: p.ticketId, number: p.number, title: p.title, role: p.role, message: p.message }
  },

  outcome(r) {
    return `Redirected the ${r.role} on #${r.number} ${JSON.stringify(r.title)}: it was interrupted and has the message ${JSON.stringify(r.message)}. If it fires again, propose a replacement.`
  }
}
