import { z } from 'zod'
import type { HoldPayload, HoldResult } from '../../shared/proposals'
import { futureDate, REASON_MAX } from '../holds/holds'
import { parsePayload, ProposalInvalid, type ProposalKind } from './kind'

const dateSchema = z.string().min(1, 'must be a date')

const proposeSchema = z.strictObject({
  ticket: z.number().int().positive(),
  until: dateSchema.optional(),
  reason: z.string().trim().min(1, 'required').max(REASON_MAX, `must be at most ${REASON_MAX} characters`)
})

/** The user's Override: a new date, or null to hold with no date. */
const overrideSchema = z.strictObject({ until: dateSchema.nullable() })

/** The date as a future ISO date-time, or a ProposalInvalid naming the field. */
function checkedDate(until: string, now: Date): string {
  try {
    return futureDate(until, now)
  } catch (err) {
    throw new ProposalInvalid(`until: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function untilText(until: string | null): string {
  return until === null ? 'with no date; it stays held until the user releases it' : `until ${until.slice(0, 10)}`
}

/**
 * Holding a ticket, optionally until a date. The user can change the date or clear it; confirming holds the
 * ticket (a ticket already held takes the new date). It never stops a running agent.
 */
export const hold: ProposalKind<HoldPayload, HoldResult> = {
  label: 'hold a ticket',
  atomicWithResult: false,

  async propose(input, turn, ctx) {
    const p = parsePayload(proposeSchema, input)
    const ticket = await ctx.ticketByNumber(turn.workspaceId, p.ticket)
    if (!ticket) throw new ProposalInvalid(`ticket: there is no ticket #${p.ticket}`)
    if (ticket.manualColumn === 'done') throw new ProposalInvalid(`ticket: #${ticket.number} is Done; a Done ticket can't be held`)
    return {
      ticketId: ticket.id,
      number: ticket.number,
      title: ticket.title,
      until: p.until === undefined ? null : checkedDate(p.until, ctx.now()),
      reason: p.reason
    }
  },

  override(stored, input, now = new Date()) {
    const o = parsePayload(overrideSchema, input)
    return { ...stored, until: o.until === null ? null : checkedDate(o.until, now) }
  },

  async execute(p, target, ctx) {
    const ws = await ctx.workspace()
    if (!ws || ws.id !== target.workspaceId) throw new Error('The workspace it was proposed for is no longer open')
    const ticket = await ctx.ticketByNumber(ws.id, p.number)
    if (!ticket || ticket.id !== p.ticketId) throw new Error(`Ticket #${p.number} no longer exists`)
    const held = await ctx.holdTicket(p.ticketId, { ...(p.until !== null ? { until: p.until } : {}), reason: p.reason })
    return { ticketId: p.ticketId, number: p.number, title: p.title, until: held.until }
  },

  outcome(r) {
    return `Held #${r.number} ${JSON.stringify(r.title)} ${untilText(r.until)}.`
  }
}
