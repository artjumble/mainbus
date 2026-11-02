import type { z } from 'zod'
import type { NewTicketInput, Ticket, Workspace } from '../../shared/domain'

/** A payload or override that doesn't validate; the message names the field. Nothing is stored or changed. */
export class ProposalInvalid extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProposalInvalid'
  }
}

/** What carrying out a proposal may use of the engine. Later kinds add to it. */
export interface ExecContext {
  /** The open workspace, or null. */
  workspace(): Promise<Workspace | null>
  /** The same path as ticket.create: creates them all in order, or none, and emits board.changed once. */
  createTickets(ws: Workspace, inputs: Omit<NewTicketInput, 'workspaceId'>[]): Promise<Ticket[]>
}

/** What the turn a proposal is made in gives it. */
export interface Turn {
  /** The user's message that started the turn, verbatim. */
  userMessage: string
}

/**
 * One kind of proposal: how its payload is validated, how the user's override is, how it is carried out, and how
 * its outcome is told to the orchestrator. Engine-filled fields are never taken from the orchestrator or the
 * override.
 */
export interface ProposalKind<P, R> {
  /** In the orchestrator's outcome block, as in "Proposal 3f… (create tickets)". */
  label: string
  /** Validates what the orchestrator sent and fills in the engine's own fields. Throws ProposalInvalid. */
  propose(input: unknown, turn: Turn): P
  /** Validates the user's override the same way; the engine's fields come from `stored`. Throws ProposalInvalid. */
  override(stored: P, input: unknown): P
  /** Carries it out; a throw makes the proposal failed, with the error as its result. */
  execute(p: P, target: { workspaceId: string }, ctx: ExecContext): Promise<R>
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
