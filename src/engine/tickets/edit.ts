import { z } from 'zod'
import type { Criterion, EditedField, EditedValues, Ticket, TicketPatch } from '../../shared/domain'
import { parsePayload, ProposalInvalid } from '../proposals/kind'
import { ticketFields } from './validate'

/**
 * What update_ticket may change, besides the `workspace` and `request_messages_back` the session takes off first. There is
 * no field for the ticket's intent: `add_user_words` can only be `true`, and the words come from the user's own messages.
 */
const editInput = z
  .object({
    ticket: z.number().int().positive(),
    title: ticketFields.title.optional(),
    spec: ticketFields.spec.optional(),
    criteria: ticketFields.criteria.optional(),
    labels: ticketFields.labels.optional(),
    /** The full new list of blockers, by ticket number; [] clears it. */
    blocked_by: z.array(z.number().int().positive()).max(50).optional(),
    add_user_words: z.literal(true).optional()
  })
  .strict()

export type EditInput = z.infer<typeof editInput>

export const NOTHING_TO_CHANGE = 'Nothing to change: the ticket already has these values'

export interface EditPlan {
  patch: TicketPatch
  /** The fields that really change, in display order. */
  fields: EditedField[]
  before: EditedValues
  after: EditedValues
  addUserWords: boolean
}

export function parseEditInput(input: unknown): EditInput {
  return parsePayload(editInput, input)
}

/**
 * The new criteria for these texts: a ticked criterion stays ticked only when its text is unchanged. Each old tick is
 * used once, so a repeated text does not tick twice as often as it was ticked.
 */
export function carryTicks(old: Criterion[], texts: string[]): Criterion[] {
  const ticked = old.filter((c) => c.checked).map((c) => c.text)
  return texts.map((text, position) => {
    const at = ticked.indexOf(text)
    if (at >= 0) ticked.splice(at, 1)
    return { position, text, checked: at >= 0 }
  })
}

const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/** Works out what the edit changes in `current`; throws ProposalInvalid when it changes nothing. */
export function planEdit(current: Ticket, input: EditInput, currentBlockers: number[] = []): EditPlan {
  const patch: TicketPatch = {}
  const before: EditedValues = {}
  const after: EditedValues = {}
  const fields: EditedField[] = []
  const changed = <K extends Exclude<EditedField, 'blockedBy'>>(field: K, old: NonNullable<EditedValues[K]>, next: NonNullable<EditedValues[K]>): void => {
    patch[field] = next as never
    before[field] = old as never
    after[field] = next as never
    fields.push(field)
  }
  if (input.title !== undefined && input.title !== current.title) changed('title', current.title, input.title)
  if (input.spec !== undefined && input.spec !== current.spec) changed('spec', current.spec, input.spec)
  if (input.criteria !== undefined && !sameList(input.criteria, current.criteria.map((c) => c.text))) {
    changed('criteria', current.criteria, carryTicks(current.criteria, input.criteria))
  }
  if (input.labels !== undefined && !sameList(input.labels, current.labels)) changed('labels', current.labels, input.labels)
  if (input.blocked_by !== undefined) {
    const next = [...new Set(input.blocked_by)].sort((a, b) => a - b)
    const old = [...currentBlockers].sort((a, b) => a - b)
    if (!sameList(next.map(String), old.map(String))) {
      before.blockedBy = old
      after.blockedBy = next
      fields.push('blockedBy')
    }
  }
  const addUserWords = input.add_user_words === true
  if (fields.length === 0 && !addUserWords) throw new ProposalInvalid(NOTHING_TO_CHANGE)
  return { patch, fields, before, after, addUserWords }
}

/**
 * Why the orchestrator can't edit this ticket, or null when it can: only a Backlog, Ready or Review ticket with no run open
 * (a run open, or one that can be continued, was given the ticket as it was). Phrased for the orchestrator, with no final stop.
 */
export function whyNotEditable(ticket: Ticket, column: string, runOpen: boolean): string | null {
  if (column === 'done') return `#${ticket.number} is Done, and Done tickets can't be edited`
  if (runOpen || column === 'in_progress') {
    return `#${ticket.number} has a run open, and editing it would change what its agents were given without telling them. Tell the user to stop the run first, or to let it finish`
  }
  if (column !== 'backlog' && column !== 'ready' && column !== 'review') {
    return `#${ticket.number} is in ${column === 'needs_you' ? 'Needs you' : column}, with a run that can still be continued, and editing it would change what its agents were given without telling them. Tell the user to deal with the run first (continue it, or stop it)`
  }
  return null
}
