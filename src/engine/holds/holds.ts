import type { EngineEvent } from '../../shared/api'
import type { Decision, Hold, HoldOptions } from '../../shared/domain'
import type { DecisionRepo } from '../store/decisions'
import type { HoldRepo } from '../store/holds'
import type { TicketRepo } from '../store/tickets'
import { MAX_TIMER_MS, type Clock } from './clock'

export const REASON_MAX = 500

export interface HoldsDeps {
  holds: HoldRepo
  tickets: Pick<TicketRepo, 'get'>
  decisions: Pick<DecisionRepo, 'get' | 'defer'>
  clock: Clock
  emit: (e: EngineEvent) => void
  /**
   * Called for each hold the clock released by its date, after the board is told: a ticket's hold, or the
   * decision that is pending again (not one answered meanwhile). Not for an unhold or a Bring back.
   */
  onReleasedByDate?: (released: { workspaceId: string; hold: Hold; decision: Decision | null }) => void | Promise<void>
}

/** Normalizes a date the user or the orchestrator gave; throws, naming the problem, when it isn't one in the future. */
export function futureDate(until: string, now: Date): string {
  const at = new Date(until)
  if (Number.isNaN(at.getTime())) throw new Error('The date is not a valid date')
  if (at.getTime() <= now.getTime()) throw new Error('The date has already passed')
  return at.toISOString()
}

/**
 * Holds on tickets and on decisions (Later…): holding and unholding, and the one timer, set for the next hold with a date, that releases
 * holds as their date passes. Holding only marks a ticket; it never touches a running agent.
 */
export class HoldService {
  private timer: unknown = null
  private disposed = false

  constructor(private readonly deps: HoldsDeps) {}

  /** At launch: releases the holds that came due while Mainbus was closed, and sets the timer for the next one. */
  async start(): Promise<void> {
    // A deferred decision left without a hold (a crash between the two) would never come back.
    await this.deps.holds.reconcileDecisions()
    await this.releaseDue()
  }

  async hold(ticketId: string, opts: HoldOptions = {}): Promise<Hold> {
    const ticket = await this.deps.tickets.get(ticketId)
    if (ticket.manualColumn === 'done') throw new Error(`#${ticket.number} is Done; a Done ticket can't be held`)
    const until = opts.until === undefined ? undefined : futureDate(opts.until, this.deps.clock.now())
    const reason = opts.reason?.trim()
    if (reason && reason.length > REASON_MAX) throw new Error(`The reason must be at most ${REASON_MAX} characters`)
    const hold = await this.deps.holds.place('ticket', ticketId, {
      ...(until !== undefined ? { until } : {}),
      ...(reason ? { reason } : {})
    })
    await this.schedule()
    this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
    return hold
  }

  /** Releases the ticket's hold; nothing happens when it has none. */
  async unhold(ticketId: string): Promise<void> {
    const released = await this.deps.holds.release('ticket', ticketId)
    if (!released) return
    await this.schedule()
    const ticket = await this.deps.tickets.get(ticketId)
    this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
  }

  /** Later…: defers the pending decision until `until`, which must be in the future. */
  async defer(decisionId: string, until: string): Promise<Decision> {
    const at = futureDate(until, this.deps.clock.now())
    const decision = await this.deps.decisions.defer(decisionId, at)
    await this.schedule()
    await this.announce(decision)
    return decision
  }

  /** Brings a deferred decision back now; throws when it isn't deferred. */
  async bringBack(decisionId: string): Promise<void> {
    const released = await this.deps.holds.release('decision', decisionId)
    if (!released) throw new Error('That decision is not deferred')
    await this.schedule()
    await this.announce(await this.deps.decisions.get(decisionId))
  }

  private async announce(decision: Decision): Promise<void> {
    const ticket = await this.deps.tickets.get(decision.ticketId).catch(() => null)
    if (ticket) {
      this.deps.emit({ type: 'decision.changed', workspaceId: ticket.workspaceId, decision })
      this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
    }
  }

  /** The ticket's hold, or null. */
  active(ticketId: string): Promise<Hold | null> {
    return this.deps.holds.active('ticket', ticketId)
  }

  /** The ids of the held tickets. */
  async heldIds(): Promise<Set<string>> {
    return new Set((await this.deps.holds.activeOf('ticket')).map((h) => h.targetId))
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) this.deps.clock.clearTimeout(this.timer)
    this.timer = null
  }

  /** Releases every hold whose date has passed, tells the board, and sets the timer for the next. */
  private async releaseDue(): Promise<void> {
    if (this.disposed) return
    const released = await this.deps.holds.releaseDue(this.deps.clock.now())
    const workspaces = new Set<string>()
    const decisions: Decision[] = []
    const news: { workspaceId: string; hold: Hold; decision: Decision | null }[] = []
    for (const hold of released) {
      if (hold.targetKind === 'decision') {
        const decision = await this.deps.decisions.get(hold.targetId).catch(() => null)
        if (decision) decisions.push(decision)
        const ticket = decision?.status === 'pending' ? await this.deps.tickets.get(decision.ticketId).catch(() => null) : null
        if (ticket) news.push({ workspaceId: ticket.workspaceId, hold, decision })
        continue
      }
      const ticket = await this.deps.tickets.get(hold.targetId).catch(() => null)
      if (ticket) {
        workspaces.add(ticket.workspaceId)
        news.push({ workspaceId: ticket.workspaceId, hold, decision: null })
      }
    }
    await this.schedule()
    for (const decision of decisions) await this.announce(decision)
    for (const workspaceId of workspaces) this.deps.emit({ type: 'board.changed', workspaceId })
    for (const item of news) await this.deps.onReleasedByDate?.(item)
  }

  /** One timer, for the next hold with a date. */
  private async schedule(): Promise<void> {
    if (this.timer !== null) this.deps.clock.clearTimeout(this.timer)
    this.timer = null
    if (this.disposed) return
    const next = await this.deps.holds.nextDue()
    if (next === null) return
    const wait = Math.min(Math.max(0, new Date(next).getTime() - this.deps.clock.now().getTime()), MAX_TIMER_MS)
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = null
      return this.releaseDue()
    }, wait)
  }
}
