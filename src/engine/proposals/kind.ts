import type { z } from 'zod'
import type { DraftColumn, ProposalOrigin } from '../../shared/proposals'
import type { StuckEpisode, Decision, DecisionAnswer, Effort, Hold, HoldOptions, IntentAddition, Lineup, LineupRole, NewTicketInput, StartOptions, Ticket, TicketState, Workspace } from '../../shared/domain'

/** A payload or override that doesn't validate; the message names the field. Nothing is stored or changed. */
export class ProposalInvalid extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProposalInvalid'
  }
}

/** What carrying out a proposal may use of the engine. Later kinds add to it. */
export interface ExecContext {
  /** The workspace with this id, or null when it was removed. */
  workspace(id: string): Promise<Workspace | null>
  /** The same path as ticket.create: creates them all in order, or none, and emits board.changed once. */
  createTickets(
    ws: Workspace,
    inputs: Omit<NewTicketInput, 'workspaceId'>[],
    /** The proposal being carried out: its result is recorded in the same transaction as the tickets. */
    record?: { proposalId: string; column: DraftColumn }
  ): Promise<Ticket[]>
  /** The workspace's lineup of that kind (the one a ticket of that kind runs), in order. */
  lineup(workspaceId: string, lineup: Lineup): Promise<LineupRole[]>
  ticketByNumber(workspaceId: string, number: number): Promise<Ticket | null>
  /** Why the ticket can't be started now (it is running, or not in Backlog or Ready), or null when it can. */
  whyNotStartable(ticket: Ticket): Promise<string | null>
  /** The same path as the ticket view's Start. */
  startTicket(ticketId: string, opts: StartOptions): Promise<void>
  /** The engine's clock, which a hold's date is checked against. */
  now(): Date
  /** The same path as the ticket view's Hold…: a held ticket takes the new date and reason. */
  holdTicket(ticketId: string, opts: HoldOptions): Promise<Hold>
  /** The ticket's open run's active role, or null with no run or an ended one. */
  activeRole(ticket: Ticket): Promise<ActiveRole | null>
  /** The same paths as the ticket view's Pause, Stop and Skip; they fail, changing nothing, if the run has moved on. */
  pauseTicket(ticketId: string, expect: { agentRunId: string }): Promise<void>
  stopTicket(ticketId: string, expect: { agentRunId: string }): Promise<void>
  skipTicket(ticketId: string, expect: { agentRunId: string }): Promise<void>
  /** The open stuck episode of an agent run, or null. */
  openStuckEpisode(agentRunId: string): Promise<StuckEpisode | null>
  /**
   * Interrupts the run's current turn (as Pause does, but keeping its process) and sends `message` as its next
   * message, recording the redirect on the open episode and the run. Fails, interrupting nothing, if the run has
   * ended or its episode has closed or was already redirected.
   */
  redirectTicket(ticketId: string, expect: { agentRunId: string; episodeId: string }, message: string, proposalId: string): Promise<void>
  /**
   * The same path as the ticket view's Replace…: ends the run's agent as replaced, with a handoff summary generated from its
   * log, and starts a fresh agent of the same role with it. Fails, changing nothing, if the run has moved on.
   */
  replaceTicket(
    ticketId: string,
    expect: { agentRunId: string },
    request: { model: string; effort: Effort; extraInstructions: string | null; proposalId: string; suggestedBy: 'orchestrator' | 'user' }
  ): Promise<void>
  /** Why the Investigate ticket's report can't be promoted now, or null when it can. */
  whyNotPromotable(ticket: Ticket): Promise<string | null>
  /** The spec for promoting the ticket's report: drafted from it, or the report itself (`drafted` false). */
  draftPromotionSpec(ticket: Ticket): Promise<{ spec: string; drafted: boolean }>
  /** The same path as the ticket view's Promote: the new Change ticket in Ready; the original moves to Done. */
  promoteTicket(ticketId: string, fields: { title: string; spec: string }): Promise<Ticket>
  /** A decision and its ticket, or null when there is none. */
  decision(id: string): Promise<{ decision: Decision; ticket: Ticket } | null>
  /** The shared answer path (the board's and the thread's too), from the orchestrator panel; refuses a decision already answered. */
  answerDecision(id: string, answer: DecisionAnswer): Promise<void>
}

/** The role working, paused or waiting on a ticket's open run. */
export interface ActiveRole {
  agentRunId: string
  role: string
  agentStatus: TicketState['agentStatus']
  /** The model and effort the active run launched with. */
  model: string
  effort: Effort
  /** The role a skip would start; null when the ticket would go to Review. */
  next: string | null
}

/** What the turn a proposal is made in gives it. */
export interface Turn {
  /**
   * The user's request, verbatim: the message that started the turn, or the earlier one the orchestrator named with
   * request_messages_back. Null when no orchestrator turn made the proposal.
   */
  userMessage: string | null
  /** The user's later messages, up to and including this turn's, when the request is an earlier one; oldest first. */
  followUps?: IntentAddition[]
  /** The workspace the proposal is made for. */
  workspaceId: string
  /** Who makes it; the orchestrator when absent. */
  origin?: ProposalOrigin
}

/**
 * One kind of proposal: how its payload is validated, how the user's override is, how it is carried out, and how
 * its outcome is told to the orchestrator. Engine-filled fields are never taken from the orchestrator or the
 * override.
 */
export interface ProposalKind<P, R> {
  /** In the orchestrator's outcome block, as in "Proposal 3f… (create tickets)". */
  label: string
  /**
   * Whether carrying it out and recording its result happen in one transaction, so that after any quit the
   * proposal has its result or nothing was done. A kind that doesn't (it starts a run, say) is false.
   */
  atomicWithResult: boolean
  /** The orchestrator's field the card shows as its evidence; 'evidence' when absent. */
  evidenceKey?: string
  /** Whether the orchestrator must give its evidence (a reason). */
  evidenceRequired?: boolean
  /**
   * Validates what the orchestrator sent, against the board where it must, and fills in the engine's own fields.
   * Throws ProposalInvalid.
   */
  propose(input: unknown, turn: Turn, ctx: ExecContext): P | Promise<P>
  /**
   * Validates the user's override the same way (`now` is the engine's time, for a kind that checks dates); the engine's fields come from `stored`. Throws ProposalInvalid.
   * Absent for a kind with nothing to change.
   */
  override?(stored: P, input: unknown, now?: Date): P
  /** Carries it out; a throw makes the proposal failed, with the error as its result. */
  execute(p: P, target: { workspaceId: string; proposalId: string }, ctx: ExecContext): Promise<R>
  /** Plain text for the orchestrator, such as `Created #21 "Title" in Backlog.` */
  outcome(r: R): string
}

/** Parses with `schema`, or throws ProposalInvalid naming the first bad field. */
export function parsePayload<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  const issue = result.error.issues[0]!
  if (issue.code === 'unrecognized_keys') {
    throw new ProposalInvalid(`Unknown field: ${[...issue.path, issue.keys[0]].map(String).join('.')}`)
  }
  const field = issue.path.map(String).join('.') || 'payload'
  throw new ProposalInvalid(`${field}: ${issue.message}`)
}
