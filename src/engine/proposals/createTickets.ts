import { z } from 'zod'
import type { IntentAddition, NewTicketInput, Ticket, Workspace } from '../../shared/domain'
import type { CreateTicketsPayload, CreateTicketsResult, DraftColumn, TicketDraft } from '../../shared/proposals'
import { ticketFields } from '../tickets/validate'
import { parsePayload, ProposalInvalid, type ExecContext, type ProposalKind, type Turn } from './kind'

export const MAX_DRAFTS = 20

export const CONTEXT_MAX = 4_000

export const COLUMN_NAMES: Record<DraftColumn, string> = { backlog: 'Backlog', ready: 'Ready' }

// Strict: there is no intent field, so an `intent` from the orchestrator is refused rather than ignored.
const draftSchema = z.strictObject({
  title: ticketFields.title,
  spec: ticketFields.spec.default(''),
  criteria: ticketFields.criteria.default([]),
  labels: ticketFields.labels.default([]),
  // No default: an override keeps the kind as it was sent.
  kind: z.enum(['change', 'investigate']).optional()
})

const draftsSchema = z
  .array(draftSchema)
  .min(1, 'must have at least 1 ticket')
  .max(MAX_DRAFTS, `must have at most ${MAX_DRAFTS} tickets`)

const contextField = z.string().max(CONTEXT_MAX, `must be at most ${CONTEXT_MAX} characters`).optional()

/** A blank summary means none: the key is left out. */
function contextOf(context: string | undefined): { context?: string } {
  const text = context?.trim()
  return text ? { context: text } : {}
}

/** What the orchestrator proposes and what the user's override sends: the same rules for both. */
const editableSchema = z.strictObject({
  tickets: draftsSchema,
  column: z.enum(['backlog', 'ready']).default('backlog'),
  context: contextField
})

/** What create_tickets sends: the same drafts, and no column, since they always go to Backlog. */
const directSchema = z.strictObject({ tickets: draftsSchema, context: contextField })

/** "#21", "#21 and #22", "#21, #22 and #23". */
export function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/**
 * The tickets to create from the drafts. The intent is the user's own words, with no source. `context`, the
 * orchestrator's summary, is added after them as an entry of its own, written by the orchestrator. `via` marks a
 * ticket the orchestrator created without a card.
 */
function ticketInputs(
  intent: string,
  intentAdded: IntentAddition[] | undefined,
  drafts: TicketDraft[],
  column: DraftColumn,
  context: { text: string; cwd: string } | undefined,
  via?: 'orchestrator'
): Omit<NewTicketInput, 'workspaceId'>[] {
  return drafts.map((d) => ({
    title: d.title,
    intent,
    ...(intentAdded?.length ? { intentAdded } : {}),
    spec: d.spec,
    criteria: d.criteria,
    labels: d.labels,
    column,
    kind: d.kind ?? 'change',
    ...(context ? { agentContext: { text: context.text, source: { kind: 'agent' as const, agent: 'orchestrator', cwd: context.cwd } } } : {}),
    ...(via ? { via } : {})
  }))
}

/**
 * Drafts of new tickets. Each ticket's intent is the user's request, verbatim, filled in by Mainbus: the message the
 * turn answers or the earlier one it names, and the user's later messages. The orchestrator can't write or widen the
 * user's words, and its own drafting goes in the spec.
 */
export const createTickets: ProposalKind<CreateTicketsPayload, CreateTicketsResult> = {
  label: 'create tickets',
  atomicWithResult: true,

  propose(input, turn) {
    if (turn.userMessage === null) throw new ProposalInvalid('Tickets can only be drafted in answer to a message of the user')
    const { context, ...rest } = parsePayload(editableSchema, input)
    return { intent: turn.userMessage, ...(turn.followUps?.length ? { intentAdded: turn.followUps } : {}), ...rest, ...contextOf(context) }
  },

  override(stored, input) {
    // The summary comes only from the override: leaving it out clears it.
    const { context, ...rest } = parsePayload(editableSchema, input)
    return { intent: stored.intent, ...(stored.intentAdded ? { intentAdded: stored.intentAdded } : {}), ...rest, ...contextOf(context) }
  },

  async execute(p, target, ctx) {
    const ws = await ctx.workspace(target.workspaceId)
    if (!ws || ws.id !== target.workspaceId) throw new Error('The workspace it was proposed for was removed')
    const created = await ctx.createTickets(ws, ticketInputs(p.intent, p.intentAdded, p.tickets, p.column, p.context ? { text: p.context, cwd: ctx.orchestratorFolder } : undefined), {
      proposalId: target.proposalId,
      column: p.column
    })
    return { tickets: created.map((t) => ({ id: t.id, number: t.number, title: t.title })), column: p.column }
  },

  outcome(r) {
    const list = listJoin(r.tickets.map((t) => `#${t.number} ${JSON.stringify(t.title)}`))
    return `Created ${list} in ${COLUMN_NAMES[r.column]}.`
  }
}

/**
 * create_tickets: the orchestrator creates the drafts in the workspace's Backlog at once, with no card. The same
 * validation and the same path as a confirmed proposal: all of them or none. Throws ProposalInvalid, creating nothing.
 */
export async function createInBacklog(
  input: unknown,
  turn: Pick<Turn, 'userMessage' | 'followUps'>,
  ws: Workspace,
  create: ExecContext['createTickets'],
  orchestratorFolder: string
): Promise<{ created: Ticket[]; withContext: boolean }> {
  if (turn.userMessage === null) throw new ProposalInvalid('Tickets can only be created in answer to a message of the user')
  const { tickets, context } = parsePayload(directSchema, input)
  const summary = contextOf(context).context
  const created = await create(
    ws,
    ticketInputs(turn.userMessage, turn.followUps, tickets, 'backlog', summary ? { text: summary, cwd: orchestratorFolder } : undefined, 'orchestrator')
  )
  return { created, withContext: summary !== undefined }
}
