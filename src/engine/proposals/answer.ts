import { z } from 'zod'
import { ANSWERED_VIA_LABELS, type Decision, type DecisionAnswer } from '../../shared/domain'
import { shortDay } from '../../shared/hold'
import { JUDGEMENT_REASONS, type AnswerChoice, type AnswerPayload, type AnswerResult } from '../../shared/proposals'
import { parsePayload, ProposalInvalid, type ProposalKind } from './kind'

export const NOTE_MAX = 2_000
const TEXT_MAX = 2_000

const PERMISSION_CHOICES = ['allow_once', 'always_allow', 'deny'] as const
const PERMISSION_LABELS: Record<(typeof PERMISSION_CHOICES)[number], string> = {
  allow_once: 'Allow once',
  always_allow: 'Always allow',
  deny: 'Deny'
}

const text = z.string().trim().min(1, 'required').max(TEXT_MAX, `must be at most ${TEXT_MAX} characters`)

const judgementSchema = z.strictObject({
  reason: z.enum(JUDGEMENT_REASONS as [string, ...string[]]),
  requirement: text,
  proposed: text,
  smallest_option: text,
  consequences: z.array(z.strictObject({ option: text, consequence: text })).min(1, 'give the consequence of each option'),
  recommendation: text
})

const noteSchema = z.string().trim().max(NOTE_MAX, `must be at most ${NOTE_MAX} characters`)

const proposeSchema = z.strictObject({
  decision: z.string().min(1, 'required'),
  // A question's option as the orchestrator's tools number them (the first is 1), or a permission's choice.
  choice: z.union([z.number().int(), z.enum(PERMISSION_CHOICES)]).optional(),
  note: noteSchema.optional(),
  judgement: judgementSchema.optional()
})

/** What the user's choice sends: an option index (from 0) or a permission's choice, and the note. */
const overrideSchema = z.strictObject({
  choice: z.union([z.number().int(), z.enum(PERMISSION_CHOICES)]),
  note: noteSchema.nullable().optional()
})

/** The labels a decision's answers go by, in order: its options, or Allow once, Always allow and Deny. */
export function choiceLabels(d: Pick<Decision, 'kind' | 'options' | 'allowAlways'>): string[] {
  if (d.kind === 'question') return d.options
  return d.allowAlways ? ['Allow once', 'Always allow', 'Deny'] : ['Allow once', 'Deny']
}

/** Why the decision can no longer be answered ("Already answered from the board", "Deferred until Tue"), or null while it is pending. */
export function whyNotPending(d: Decision, now: Date): string | null {
  switch (d.status) {
    case 'pending':
      return null
    case 'answered':
      return d.answeredVia ? `Already answered from ${ANSWERED_VIA_LABELS[d.answeredVia]}` : 'Already answered'
    case 'deferred':
      return d.deferredUntil ? `Deferred until ${shortDay(d.deferredUntil, now)}` : 'Deferred'
    default:
      return `The decision is ${d.status}, not pending`
  }
}

/** Checks a choice against the decision's kind and options, or throws a ProposalInvalid naming `field`. */
function checkChoice(
  p: Pick<AnswerPayload, 'decisionKind' | 'options' | 'allowAlways'>,
  choice: AnswerChoice,
  field: string
): void {
  if (p.decisionKind === 'permission') {
    if (typeof choice !== 'string') throw new ProposalInvalid(`${field}: this is a permission request; choose allow_once, always_allow or deny`)
    if (choice === 'always_allow' && !p.allowAlways) {
      throw new ProposalInvalid(`${field}: "Always allow" is not offered for this request; choose allow_once or deny`)
    }
    return
  }
  if (typeof choice !== 'number' || choice < 0 || choice >= p.options.length) {
    throw new ProposalInvalid(`${field}: must be one of the ${p.options.length} options`)
  }
}

function labelOf(p: Pick<AnswerPayload, 'decisionKind' | 'options'>, choice: AnswerChoice): string {
  return typeof choice === 'number' ? p.options[choice]! : PERMISSION_LABELS[choice]
}

/**
 * Answering a decision an agent is waiting on. A plain recommendation is confirmed, or overridden with another
 * option and note. One that needs the user's own judgement carries its `judgement`, and is only ever answered by
 * the user choosing an option. Confirming answers through the same path as the board, from the orchestrator panel.
 */
export const answer: ProposalKind<AnswerPayload, AnswerResult> = {
  label: 'answer a question',
  atomicWithResult: false,
  evidenceKey: 'reasoning',
  evidenceRequired: true,

  async propose(input, turn, ctx) {
    const p = parsePayload(proposeSchema, input)
    const found = await ctx.decision(p.decision)
    if (!found || found.ticket.workspaceId !== turn.workspaceId) throw new ProposalInvalid(`decision: there is no decision ${p.decision}`)
    const { decision, ticket } = found
    const stale = whyNotPending(decision, ctx.now())
    if (stale) throw new ProposalInvalid(`decision: ${stale}`)

    const base = {
      decisionKind: decision.kind,
      options: choiceLabels(decision),
      allowAlways: decision.allowAlways
    }
    let choice: AnswerChoice | null = null
    if (p.choice !== undefined) {
      // A question's option arrives as the number its tools show (from 1); it is stored as an index.
      choice = typeof p.choice === 'number' ? p.choice - 1 : p.choice
      checkChoice(base, choice, 'choice')
    } else if (!p.judgement) {
      throw new ProposalInvalid('choice: required, unless the answer needs the user\'s judgement (then give a judgement)')
    }
    return {
      decisionId: decision.id,
      ticketId: ticket.id,
      number: ticket.number,
      title: ticket.title,
      question: decision.question,
      ...base,
      choice,
      note: p.note === undefined || p.note === '' ? null : p.note,
      judgement: p.judgement ? (p.judgement as AnswerPayload['judgement']) : null
    }
  },

  override(stored, input) {
    const o = parsePayload(overrideSchema, input)
    checkChoice(stored, o.choice, 'choice')
    return { ...stored, choice: o.choice, note: o.note === undefined || o.note === null || o.note === '' ? null : o.note, userChose: true }
  },

  async execute(p, _target, ctx) {
    const found = await ctx.decision(p.decisionId)
    if (!found) throw new Error('The decision no longer exists')
    // Whatever answered or deferred it since, the user is told, and nothing is delivered to the agent twice.
    const stale = whyNotPending(found.decision, ctx.now())
    if (stale) throw new Error(stale)
    if (p.choice === null || (p.judgement !== null && p.userChose !== true)) {
      throw new Error('This needs your own choice: pick one of the options')
    }
    const note = p.note === null ? {} : { note: p.note }
    const a: DecisionAnswer =
      typeof p.choice === 'number' ? { kind: 'option', index: p.choice, ...note } : { kind: 'permission', choice: p.choice, ...note }
    await ctx.answerDecision(p.decisionId, a)
    return {
      decisionId: p.decisionId,
      ticketId: p.ticketId,
      number: p.number,
      title: p.title,
      question: p.question,
      answer: labelOf(p, p.choice),
      note: p.note
    }
  },

  outcome(r) {
    const note = r.note === null ? '' : ` with the note ${JSON.stringify(r.note)}`
    return `Answered #${r.number} ${JSON.stringify(r.title)}'s question ${JSON.stringify(r.question)}: ${JSON.stringify(r.answer)}${note}. The agent has it.`
  }
}
