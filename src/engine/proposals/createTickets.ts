import { z } from 'zod'
import type { CreateTicketsPayload, CreateTicketsResult, DraftColumn } from '../../shared/proposals'
import { ticketFields } from '../tickets/validate'
import { parsePayload, type ProposalKind } from './kind'

export const MAX_DRAFTS = 20

export const COLUMN_NAMES: Record<DraftColumn, string> = { backlog: 'Backlog', ready: 'Ready' }

// Strict: there is no intent field, so an `intent` from the orchestrator is refused rather than ignored.
const draftSchema = z.strictObject({
  title: ticketFields.title,
  spec: ticketFields.spec.default(''),
  criteria: ticketFields.criteria.default([]),
  labels: ticketFields.labels.default([])
})

/** What the orchestrator proposes and what the user's override sends: the same rules for both. */
const editableSchema = z.strictObject({
  tickets: z
    .array(draftSchema)
    .min(1, 'must have at least 1 ticket')
    .max(MAX_DRAFTS, `must have at most ${MAX_DRAFTS} tickets`),
  column: z.enum(['backlog', 'ready']).default('backlog')
})

/** "#21", "#21 and #22", "#21, #22 and #23". */
export function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/**
 * Drafts of new tickets. Each ticket's intent is the user's message that started the turn, verbatim, filled in
 * by Mainbus: the orchestrator can't write or widen the user's words, and its own drafting goes in the spec.
 */
export const createTickets: ProposalKind<CreateTicketsPayload, CreateTicketsResult> = {
  label: 'create tickets',

  propose(input, turn) {
    return { intent: turn.userMessage, ...parsePayload(editableSchema, input) }
  },

  override(stored, input) {
    return { intent: stored.intent, ...parsePayload(editableSchema, input) }
  },

  async execute(p, target, ctx) {
    const ws = await ctx.workspace()
    if (!ws || ws.id !== target.workspaceId) throw new Error('The workspace it was proposed for is no longer open')
    // No source: the intent is the user's own words, not an agent's.
    const created = await ctx.createTickets(
      ws,
      p.tickets.map((d) => ({ title: d.title, intent: p.intent, spec: d.spec, criteria: d.criteria, labels: d.labels, column: p.column }))
    )
    return { tickets: created.map((t) => ({ id: t.id, number: t.number, title: t.title })), column: p.column }
  },

  outcome(r) {
    const list = listJoin(r.tickets.map((t) => `#${t.number} ${JSON.stringify(t.title)}`))
    return `Created ${list} in ${COLUMN_NAMES[r.column]}.`
  }
}
