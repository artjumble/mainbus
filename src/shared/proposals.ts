// Shared by the engine and the renderer: types only, no Node imports.
import type { ImageRef } from './attachments'
import type { Effort, IntentAddition, TicketKind } from './domain'
import type { ModelSource } from './models'

/**
 * pending until the user decides; confirmed as proposed or overridden with their changes (both then carried
 * out); rejected; or failed when carrying it out threw.
 */
export type ProposalStatus = 'pending' | 'confirmed' | 'overridden' | 'rejected' | 'failed'

export type ProposalKindName = 'create_tickets' | 'start_lineup' | 'pause' | 'stop' | 'skip' | 'hold' | 'answer' | 'redirect' | 'replace' | 'promote' | 'update_from_main'

/**
 * Who made the proposal: the orchestrator in a turn, or the engine when the user dragged a card into In progress
 * or pressed a ticket's Replace… button.
 */
export type ProposalOrigin = 'orchestrator' | 'drag' | 'button'

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
  /** Absent means change. */
  kind?: TicketKind
  /** Images the user sent with the request, to attach to the ticket; absent means none. */
  images?: ImageRef[]
  /** What blocks it: an existing ticket's number, or `{ draft }`, the index of an earlier draft of the same proposal. */
  blocked_by?: (number | { draft: number })[]
  /** The name of one of the workspace's presets: the ticket starts with its run settings. Change tickets only. */
  preset?: string
}

/** A draft as the user's Override sends it: the images it keeps, by id. */
export type TicketDraftOverride = Omit<TicketDraft, 'images'> & { images?: string[] }

export type DraftColumn = 'backlog' | 'ready'

/** The payload of a create_tickets proposal. `intent` is filled in by Mainbus: the user's message, verbatim. */
export interface CreateTicketsPayload {
  intent: string
  /** The user's later messages when the request spanned turns, verbatim; absent on proposals stored before it was kept. */
  intentAdded?: IntentAddition[]
  tickets: TicketDraft[]
  column: DraftColumn
  /** The orchestrator's summary of the conversation: background, not the user's words; absent when none was given. */
  context?: string
}

/** What the user's Override sends for create_tickets: the drafts they kept, as edited, and the column. */
export interface CreateTicketsOverride {
  tickets: TicketDraftOverride[]
  column: DraftColumn
  /** Absent clears the summary. */
  context?: string
}

export interface CreateTicketsResult {
  tickets: { id: string; number: number; title: string; preset?: string }[]
  column: DraftColumn
  /** What a preset dropped because the workspace's lineup lacks the role, one sentence each; absent when nothing was. */
  notices?: string[]
  /** How many images were attached, in all; absent when none were. */
  images?: number
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
  /** Set when the user asked for the start (a drag, or start-when-ready) while these blockers weren't Done: confirming starts it anyway. */
  blockedBy?: { number: number; title: string }[]
  /** Set when the orchestrator chose a preset for this start: its name, and what it dropped because the lineup changed. */
  preset?: { name: string; notices: string[] }
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

/** The payload of a hold proposal; `until` is an ISO date-time, absent for a hold with no date. */
export interface HoldPayload {
  ticketId: string
  number: number
  title: string
  until: string | null
  reason: string
}

/** What the user's Override sends for a hold: the date, or null to hold with no date. */
export interface HoldOverride {
  until: string | null
}

export interface HoldResult {
  ticketId: string
  number: number
  title: string
  until: string | null
}

/** The payload of a promote proposal: the Investigate ticket and the Change ticket it would become. */
export interface PromotePayload {
  ticketId: string
  number: number
  fromTitle: string
  title: string
  spec: string
  /** Where the spec came from: the orchestrator, a summary of the report, or the report itself. */
  specSource: 'orchestrator' | 'summary' | 'report'
}

/** What the user's Override sends for a promote: the new ticket's title and spec. */
export interface PromoteOverride {
  title: string
  spec: string
}

export interface PromoteResult {
  ticketId: string
  number: number
  title: string
  fromTicketId: string
  fromNumber: number
}

/** The payload of an update_from_main proposal: the ticket, how far behind it was, and the run that would end. */
export interface UpdateFromMainPayload {
  ticketId: string
  number: number
  title: string
  /** The base branch's name. */
  base: string
  behind: number
  conflicts: string[]
  /** The open run (paused or waiting on the user) the update would end as stopped, or null when none is open. */
  agentRunId: string | null
  role: string | null
}

export interface UpdateFromMainResult {
  ticketId: string
  number: number
  title: string
  base: string
  behind: number
  conflicts: string[]
}

/** What an answer proposal picks: a question's option by index (from 0), or a permission's choice. */
export type AnswerChoice = number | 'allow_once' | 'always_allow' | 'deny'

export type JudgementReason = 'widens_intent' | 'open_question' | 'recurring_theme' | 'destructive'

export const JUDGEMENT_REASONS: readonly JudgementReason[] = ['widens_intent', 'open_question', 'recurring_theme', 'destructive']

/** Why a decision needs the user's own judgement, laid out for them to decide. */
export interface Judgement {
  reason: JudgementReason
  /** The user's requirement the decision is about. */
  requirement: string
  /** What the agent proposes. */
  proposed: string
  /** The smallest option that stays within the user's intent. */
  smallest_option: string
  consequences: { option: string; consequence: string }[]
  recommendation: string
}

/**
 * The payload of an answer proposal. The decision's own fields are copied when it is proposed, so the card can
 * show it; `options` are the labels of the choices, in order.
 */
export interface AnswerPayload {
  decisionId: string
  ticketId: string
  number: number
  title: string
  question: string
  decisionKind: 'question' | 'permission'
  options: string[]
  allowAlways: boolean
  /** The recommended answer; null for a judgement card that recommends none. */
  choice: AnswerChoice | null
  note: string | null
  judgement: Judgement | null
  /** Set by the user's own choice (an Override): a judgement is never answered without it. */
  userChose?: true
}

/** What the user's choice sends for an answer proposal. */
export interface AnswerOverride {
  choice: AnswerChoice
  note: string | null
}

export interface AnswerResult {
  decisionId: string
  ticketId: string
  number: number
  title: string
  question: string
  /** The label of the option answered with. */
  answer: string
  note: string | null
}

/** The payload of a redirect proposal: the stuck episode of the run it is for, and the one corrective message. */
export interface RedirectPayload {
  ticketId: string
  number: number
  title: string
  agentRunId: string
  episodeId: string
  role: string
  /** The episode's evidence lines when it was proposed, for the card. */
  episodeEvidence: string[]
  message: string
}

/** What the user's Override sends for a redirect: the message, edited. */
export interface RedirectOverride {
  message: string
}

export interface RedirectResult {
  ticketId: string
  number: number
  title: string
  role: string
  message: string
}

/**
 * The payload of a replace proposal: the run to replace and the stuck episode that led to it (null when the user
 * asked with the ticket's Replace… button), with the model, effort and extra instructions the new run gets.
 */
export interface ReplacePayload {
  ticketId: string
  number: number
  title: string
  agentRunId: string
  role: string
  episodeId: string | null
  /** The episode's evidence lines when it was proposed; empty without an episode. */
  episodeEvidence: string[]
  /** Why a replacement, in the orchestrator's words or Mainbus's. */
  reason: string
  model: string
  effort: Effort
  extraInstructions: string | null
}

/** What the user's Override sends for a replace: the new run's model and effort, and its extra instructions. */
export interface ReplaceOverride {
  model: string
  effort: Effort
  extraInstructions: string
}

export interface ReplaceResult {
  ticketId: string
  number: number
  title: string
  role: string
  model: string
  effort: Effort
}

/** The result of a proposal that failed while being carried out. */
export interface ProposalFailure {
  error: string
}
