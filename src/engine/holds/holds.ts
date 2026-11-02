import type { EngineEvent } from '../../shared/api'
import type { Hold, HoldOptions } from '../../shared/domain'
import type { HoldRepo } from '../store/holds'
import type { TicketRepo } from '../store/tickets'
import { MAX_TIMER_MS, type Clock } from './clock'

export const REASON_MAX = 500

export interface HoldsDeps {
  holds: HoldRepo
  tickets: Pick<TicketRepo, 'get'>
  clock: Clock
  emit: (e: EngineEvent) => void
}

/** Normalizes a date the user or the orchestrator gave; throws, naming the problem, when it isn't one in the future. */
export function futureDate(until: string, now: Date): string {
  const at = new Date(until)
  if (Number.isNaN(at.getTime())) throw new Error('The date is not a valid date')
  if (at.getTime() <= now.getTime()) throw new Error('The date has already passed')
  return at.toISOString()
}

/**
 * Holds on tickets: holding and unholding, and the one timer, set for the next hold with a date, that releases
 * holds as their date passes. Holding only marks a ticket; it never touches a running agent.
 */
export class HoldService {
  private timer: unknown = null
  private disposed = false

  constructor(private readonly deps: HoldsDeps) {}

  /** At launch: releases the holds that came due while Mainbus was closed, and sets the timer for the next one. */
  async start(): Promise<void> {
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
    for (const hold of released) {
      if (hold.targetKind !== 'ticket') continue
      const ticket = await this.deps.tickets.get(hold.targetId).catch(() => null)
      if (ticket) workspaces.add(ticket.workspaceId)
    }
    await this.schedule()
    for (const workspaceId of workspaces) this.deps.emit({ type: 'board.changed', workspaceId })
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
