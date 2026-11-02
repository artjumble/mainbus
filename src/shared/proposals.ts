// Shared by the engine and the renderer: types only, no Node imports.
import type { Effort } from './domain'
import type { ModelSource } from './models'

/**
 * pending until the user decides; confirmed as proposed or overridden with their changes (both then carried
 * out); rejected; or failed when carrying it out threw.
 */
export type ProposalStatus = 'pending' | 'confirmed' | 'overridden' | 'rejected' | 'failed'

export type ProposalKindName = 'create_tickets' | 'start_lineup' | 'pause' | 'stop' | 'skip'

/** Who made the proposal: the orchestrator in a turn, or the engine when the user dragged a card into In progress. */
export type ProposalOrigin = 'orchestrator' | 'drag'

/** Something the orchestrator proposed, which engine code carries out once the user confirms it. */
export interface Proposal {
  id: string
  workspaceId: string
  orchestratorRunId: string
  kind: ProposalKindName
  origin: ProposalOrigin
  /** As proposed; an override is reflected in the result, never written back here. */
  payload: unknown
  /** What the orchestrator says led to it, or null. */
  evidence: string | null
  status: ProposalStatus
  /** The kind's result once carried out, `{ error }` when that failed, else null. */
  result: unknown
  createdAt: string
  decidedAt: string | null
}

/** One ticket the orchestrator drafted. */
export interface TicketDraft {
  title: string
  spec: string
  criteria: string[]
  labels: string[]
}

export type DraftColumn = 'backlog' | 'ready'

/** The payload of a create_tickets proposal. `intent` is filled in by Mainbus: the user's message, verbatim. */
export interface CreateTicketsPayload {
  intent: string
  tickets: TicketDraft[]
  column: DraftColumn
}

/** What the user's Override sends for create_tickets: the drafts they kept, as edited, and the column. */
export interface CreateTicketsOverride {
  tickets: TicketDraft[]
  column: DraftColumn
}

export interface CreateTicketsResult {
  tickets: { id: string; number: number; title: string }[]
  column: DraftColumn
}

/** One role of a start_lineup proposal, with the model and effort it will run with. */
export interface StartRolePlan {
  /** The role's id in the workspace lineup. */
  roleId: string
  name: string
  model: string
  effort: Effort
  /** Where the model came from: the user's override, the role's own setting, the orchestrator or the defaults. */
  source: ModelSource
}

/** The payload of a start_lineup proposal: the roles in lineup order, resolved when it was proposed. */
export interface StartLineupPayload {
  ticketId: string
  number: number
  title: string
  roles: StartRolePlan[]
  extraInstructions: string | null
}

/** What the user's Override sends for start_lineup: the roles they kept, each one's model and effort. */
export interface StartLineupOverride {
  roles: { roleId: string; model: string; effort: Effort }[]
  extraInstructions: string
}

export interface StartLineupResult {
  ticketId: string
  number: number
  title: string
  roles: { name: string; model: string; effort: Effort }[]
}

/** The payload of a pause, stop or skip proposal: the role that was active when it was proposed. */
export interface RoleControlPayload {
  ticketId: string
  number: number
  title: string
  agentRunId: string
  role: string
  /** Skip only: the role that would start next, or null when the ticket would go to Review. */
  next: string | null
}

export interface RoleControlResult {
  ticketId: string
  number: number
  title: string
  role: string
  /** Skip only: the role that started, or null when the ticket went to Review. */
  next: string | null
}

/** The result of a proposal that failed while being carried out. */
export interface ProposalFailure {
  error: string
}
