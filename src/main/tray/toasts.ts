import type { Arrival } from './activity'

export type Timer = (fn: () => void, ms: number) => () => void

export const BATCH_MS = 1500

/**
 * Collects the tickets that reached Needs you or Review and flushes them as one batch after a short window, so
 * several at once make one toast. Arrivals are kept only while `hidden()` says the window isn't in front of the user.
 */
export class ToastBatcher {
  private pending: Arrival[] = []
  private cancel: (() => void) | null = null

  constructor(private readonly o: { timer: Timer; hidden: () => boolean; flush: (batch: Arrival[]) => void; ms?: number }) {}

  add(arrivals: Arrival[]): void {
    if (arrivals.length === 0 || !this.o.hidden()) return
    this.pending.push(...arrivals)
    this.cancel ??= this.o.timer(() => this.flushNow(), this.o.ms ?? BATCH_MS)
  }

  private flushNow(): void {
    this.cancel = null
    const batch = this.pending
    this.pending = []
    if (batch.length > 0) this.o.flush(batch)
  }

  dispose(): void {
    this.cancel?.()
    this.cancel = null
    this.pending = []
  }
}
