import { z } from 'zod'
import { ATTACHMENTS_PER_TICKET, type ImageRef } from '../../shared/attachments'
import { PRESET_NAME_MAX, type IntentAddition, type LineupPreset, type LineupRole, type RunSettings, type Ticket, type Workspace } from '../../shared/domain'
import { findPreset, presetNames, presetRunSettings } from '../../shared/runSettings'
import type { CreateTicketsPayload, CreateTicketsResult, DraftColumn, TicketDraft } from '../../shared/proposals'
import { ticketFields } from '../tickets/validate'
import { parsePayload, ProposalInvalid, type ExecContext, type ProposalKind, type TicketToCreate, type Turn } from './kind'

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
  kind: z.enum(['change', 'investigate']).optional(),
  // By name from the orchestrator, by id from the user's override; resolved against the request's images.
  images: z.array(z.string()).max(ATTACHMENTS_PER_TICKET, `must have at most ${ATTACHMENTS_PER_TICKET} images`).optional(),
  blocked_by: z.array(z.union([z.number().int().positive(), z.strictObject({ draft: z.number().int().min(0) })])).max(MAX_DRAFTS).optional(),
  // By name; resolved to the preset's run settings, which the ticket then keeps as its own.
  preset: z.string().trim().min(1).max(PRESET_NAME_MAX).optional()
})

type ParsedDraft = z.infer<typeof draftSchema>

/**
 * The drafts with their images resolved: each name (or id, from an override) must be one of `allowed`, the images the
 * user sent with the request. Named twice, an image is attached once.
 */
function withImages(drafts: ParsedDraft[], allowed: ImageRef[], by: 'filename' | 'id'): TicketDraft[] {
  return drafts.map(({ images, ...d }, i) => {
    if (images === undefined || images.length === 0) return d
    const refs: ImageRef[] = []
    for (const given of images) {
      const found =
        by === 'id' ? allowed.find((a) => a.id === given) : allowed.find((a) => a.filename.toLowerCase() === given.trim().toLowerCase())
      if (!found) {
        throw new ProposalInvalid(
          by === 'id'
            ? `tickets.${i}.images: ${given} is not one of the proposal's images`
            : `tickets.${i}.images: ${given} is not an image the user sent in the request's messages` +
                (allowed.length > 0 ? ` (those are ${allowed.map((a) => a.filename).join(', ')})` : ' (they sent none)')
        )
      }
      if (!refs.some((r) => r.id === found.id)) refs.push({ id: found.id, filename: found.filename })
    }
    return { ...d, images: refs }
  })
}

type Blockers = ({ id: string } | { draft: number })[]

/** Where the workspace's presets and Change lineup come from, when a draft names a preset. */
export type PresetSource = (workspaceId: string) => Promise<{ presets: LineupPreset[]; lineup: LineupRole[] }>

/** The presets of an execution context as a source; undefined when it has none. */
function presetSourceOf(ctx: ExecContext): PresetSource | undefined {
  if (!ctx.presets) return undefined
  return async (workspaceId) => ({ presets: await ctx.presets!(workspaceId), lineup: await ctx.lineup(workspaceId, 'change') })
}

/**
 * Each draft's run settings from its preset (null for none, or when the preset comes to the lineup's defaults), and what
 * the presets dropped. Throws ProposalInvalid for an unknown name, a preset on an Investigate ticket, or no way to look
 * presets up. Looks nothing up when no draft names a preset.
 */
async function resolvePresets(
  drafts: { kind?: string; preset?: string }[],
  workspace: { id: string; name: string },
  source: PresetSource | undefined
): Promise<{ settings: (RunSettings | null)[]; notices: string[] }> {
  const settings: (RunSettings | null)[] = drafts.map(() => null)
  const notices: string[] = []
  if (!drafts.some((d) => d.preset !== undefined)) return { settings, notices }
  if (!source) throw new ProposalInvalid('presets are not available here')
  const { presets, lineup } = await source(workspace.id)
  for (const [i, d] of drafts.entries()) {
    if (d.preset === undefined) continue
    if (d.kind === 'investigate') throw new ProposalInvalid(`tickets.${i}.preset: presets are for Change tickets`)
    const preset = findPreset(presets, d.preset)
    if (!preset) {
      throw new ProposalInvalid(`tickets.${i}.preset: there is no preset ${JSON.stringify(d.preset)} in ${workspace.name}; its presets are ${presetNames(presets)}`)
    }
    const resolved = presetRunSettings(preset, lineup)
    settings[i] = resolved.settings
    notices.push(...resolved.notices.map((n) => `Ticket ${i + 1}: ${n}`))
  }
  return { settings, notices }
}

/** Throws unless every draft index names an earlier draft, so a series is created in order. */
function checkDraftIndexes(drafts: { blocked_by?: (number | { draft: number })[] }[]): void {
  for (const [i, d] of drafts.entries()) {
    for (const b of d.blocked_by ?? []) {
      if (typeof b !== 'number' && b.draft >= i) {
        throw new ProposalInvalid(`tickets.${i}.blocked_by: draft ${b.draft} isn't an earlier ticket of this call (a ticket can only be blocked by one listed before it)`)
      }
    }
  }
}

/**
 * Each draft's blockers resolved: a ticket number to the ticket's id (it must exist in the workspace), a draft index
 * kept as it is. Throws ProposalInvalid.
 */
export async function resolveBlockers(
  drafts: { blocked_by?: (number | { draft: number })[] }[],
  byNumber: (number: number) => Promise<Ticket | null>
): Promise<Blockers[]> {
  checkDraftIndexes(drafts)
  const out: Blockers[] = []
  for (const [i, d] of drafts.entries()) {
    const resolved: Blockers = []
    for (const b of d.blocked_by ?? []) {
      if (typeof b === 'number') {
        const ticket = await byNumber(b)
        if (!ticket) throw new ProposalInvalid(`tickets.${i}.blocked_by: there is no ticket #${b}`)
        resolved.push({ id: ticket.id })
      } else {
        resolved.push({ draft: b.draft })
      }
    }
    out.push(resolved)
  }
  return out
}

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
  blockers: Blockers[],
  runSettings: (RunSettings | null)[],
  via?: 'orchestrator'
): TicketToCreate[] {
  return drafts.map((d, i) => ({
    title: d.title,
    intent,
    ...(intentAdded?.length ? { intentAdded } : {}),
    spec: d.spec,
    criteria: d.criteria,
    labels: d.labels,
    column,
    kind: d.kind ?? 'change',
    ...(context ? { agentContext: { text: context.text, source: { kind: 'agent' as const, agent: 'orchestrator', cwd: context.cwd } } } : {}),
    ...(via ? { via } : {}),
    ...(blockers[i]?.length ? { blockedBy: blockers[i] } : {}),
    ...(runSettings[i] ? { runSettings: runSettings[i] } : {}),
    ...(d.images?.length ? { images: d.images.map((i) => i.id) } : {})
  }))
}

/** How many images the drafts attach, in all; absent when none. */
function imageCount(drafts: TicketDraft[]): { images?: number } {
  const n = drafts.reduce((total, d) => total + (d.images?.length ?? 0), 0)
  return n > 0 ? { images: n } : {}
}

/**
 * Drafts of new tickets. Each ticket's intent is the user's request, verbatim, filled in by Mainbus: the message the
 * turn answers or the earlier one it names, and the user's later messages. The orchestrator can't write or widen the
 * user's words, and its own drafting goes in the spec.
 */
export const createTickets: ProposalKind<CreateTicketsPayload, CreateTicketsResult> = {
  label: 'create tickets',
  atomicWithResult: true,

  propose(input, turn, ctx) {
    if (turn.userMessage === null) throw new ProposalInvalid('Tickets can only be drafted in answer to a message of the user')
    const { context, tickets, ...rest } = parsePayload(editableSchema, input)
    const payload: CreateTicketsPayload = {
      intent: turn.userMessage,
      ...(turn.followUps?.length ? { intentAdded: turn.followUps } : {}),
      tickets: withImages(tickets, turn.images ?? [], 'filename'),
      ...rest,
      ...contextOf(context)
    }
    // Only a draft that names a ticket by number or a preset needs the board; the others are checked at once.
    if (!tickets.some((d) => d.preset !== undefined || d.blocked_by?.some((b) => typeof b === 'number'))) {
      checkDraftIndexes(tickets)
      return payload
    }
    return (async () => {
      await resolveBlockers(tickets, (n) => ctx.ticketByNumber(turn.workspaceId, n))
      if (tickets.some((d) => d.preset !== undefined)) {
        const ws = await ctx.workspace(turn.workspaceId)
        await resolvePresets(tickets, { id: turn.workspaceId, name: ws?.name ?? 'this workspace' }, presetSourceOf(ctx))
      }
      return payload
    })()
  },

  override(stored, input) {
    // The summary comes only from the override: leaving it out clears it.
    const { context, tickets, ...rest } = parsePayload(editableSchema, input)
    checkDraftIndexes(tickets)
    // Only the images the proposal had: the user can untick them, never add others.
    const proposed = stored.tickets.flatMap((d) => d.images ?? [])
    return {
      intent: stored.intent,
      ...(stored.intentAdded ? { intentAdded: stored.intentAdded } : {}),
      tickets: withImages(tickets, proposed, 'id'),
      ...rest,
      ...contextOf(context)
    }
  },

  async execute(p, target, ctx) {
    const ws = await ctx.workspace(target.workspaceId)
    if (!ws || ws.id !== target.workspaceId) throw new Error('The workspace it was proposed for was removed')
    const blockers = await resolveBlockers(p.tickets, (n) => ctx.ticketByNumber(ws.id, n))
    // Resolved again now: a preset removed since the proposal was made fails here, with the reason.
    const presets = await resolvePresets(p.tickets, ws, presetSourceOf(ctx))
    const created = await ctx.createTickets(
      ws,
      ticketInputs(p.intent, p.intentAdded, p.tickets, p.column, p.context ? { text: p.context, cwd: ctx.orchestratorFolder } : undefined, blockers, presets.settings),
      { proposalId: target.proposalId, column: p.column }
    )
    return {
      tickets: created.map((t, i) => ({ id: t.id, number: t.number, title: t.title, ...(p.tickets[i]?.preset !== undefined ? { preset: p.tickets[i]!.preset } : {}) })),
      column: p.column,
      ...(presets.notices.length > 0 ? { notices: presets.notices } : {}),
      ...imageCount(p.tickets)
    }
  },

  outcome(r) {
    const list = listJoin(r.tickets.map((t) => `#${t.number} ${JSON.stringify(t.title)}${t.preset ? ` (${t.preset} preset)` : ''}`))
    return `Created ${list} in ${COLUMN_NAMES[r.column]}${imagesAttached(r.images)}.${(r.notices ?? []).map((n) => ` ${n}`).join('')}`
  }
}

/** ", with 2 images attached", or nothing. */
export function imagesAttached(n: number | undefined): string {
  return n ? `, with ${n} ${n === 1 ? 'image' : 'images'} attached` : ''
}

/**
 * create_tickets: the orchestrator creates the drafts in the workspace's Backlog at once, with no card. The same
 * validation and the same path as a confirmed proposal: all of them or none. Throws ProposalInvalid, creating nothing.
 */
export async function createInBacklog(
  input: unknown,
  turn: Pick<Turn, 'userMessage' | 'followUps' | 'images'>,
  ws: Workspace,
  create: ExecContext['createTickets'],
  orchestratorFolder: string,
  byNumber: (number: number) => Promise<Ticket | null> = async () => null,
  presetSource?: PresetSource
): Promise<{ created: Ticket[]; presets: (string | undefined)[]; notices: string[]; withContext: boolean; images?: number }> {
  if (turn.userMessage === null) throw new ProposalInvalid('Tickets can only be created in answer to a message of the user')
  const parsed = parsePayload(directSchema, input)
  const tickets = withImages(parsed.tickets, turn.images ?? [], 'filename')
  const summary = contextOf(parsed.context).context
  const blockers = await resolveBlockers(parsed.tickets, byNumber)
  const presets = await resolvePresets(parsed.tickets, ws, presetSource)
  const created = await create(
    ws,
    ticketInputs(turn.userMessage, turn.followUps, tickets, 'backlog', summary ? { text: summary, cwd: orchestratorFolder } : undefined, blockers, presets.settings, 'orchestrator')
  )
  return { created, presets: parsed.tickets.map((d) => d.preset), notices: presets.notices, withContext: summary !== undefined, ...imageCount(tickets) }
}
