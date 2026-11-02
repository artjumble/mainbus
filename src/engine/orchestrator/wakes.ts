import type { Clock } from '../holds/clock'
import type { Wake, WakeRepo } from '../store/wakes'

/** Rows that pile up are given to the orchestrator in one turn, this long after the first; and turns start at least this far apart. */
export const WAKE_DEBOUNCE_MS = 5000

export interface WakeSchedulerDeps {
  repo: Pick<WakeRepo, 'pending'>
  clock: Clock
  /** Starts a wake turn for these rows; resolves once the turn has been sent (or turned down). */
  wake: (rows: Wake[]) => Promise<void>
  /** True while an orchestrator turn is running or starting. */
  busy: () => boolean
  /** When Mainbus is usage-limited, the time (ms since the epoch) the limit resets; otherwise null. */
  usageLimitedUntil: () => number | null
  /** False when no turn can be started at all (no runtime, no workspace): the rows then stay pending. */
  canWake: () => Promise<boolean>
}

/**
 * Decides when pending wake rows become an orchestrator turn: after the debounce, never two turns within it,
 * never while a turn is running, and not while Mainbus is usage-limited. The rows live in the database; this
 * only keeps one timer. After a wake turn fails or is interrupted nothing retries by itself: the rows wait for
 * a new row, a later successful turn, or the next launch.
 */
export class WakeScheduler {
  private timer: unknown = null
  private started = false
  private disposed = false
  private blocked = false
  private lastStartedAt: number | null = null

  constructor(private readonly deps: WakeSchedulerDeps) {}

  /** At launch: rows left pending by the last run are presented again. */
  async start(): Promise<void> {
    this.started = true
    this.blocked = false
    await this.armIfPending()
  }

  /** A row was added. */
  added(): void {
    this.blocked = false
    this.arm()
  }

  /** An orchestrator turn (the user's or a wake) ended; rows that came meanwhile get their turn now. */
  turnEnded(ok: boolean): Promise<void> {
    this.blocked = !ok
    return ok ? this.armIfPending() : Promise.resolve()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) this.deps.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private async armIfPending(): Promise<void> {
    if ((await this.deps.repo.pending().catch(() => [])).length > 0) this.arm()
  }

  private arm(): void {
    if (!this.started || this.disposed || this.blocked || this.timer !== null) return
    const now = this.deps.clock.now().getTime()
    let at = now + WAKE_DEBOUNCE_MS
    if (this.lastStartedAt !== null) at = Math.max(at, this.lastStartedAt + WAKE_DEBOUNCE_MS)
    const limit = this.deps.usageLimitedUntil()
    if (limit !== null && limit > at) at = limit
    this.timer = this.deps.clock.setTimeout(() => this.fire(), Math.max(0, at - now))
  }

  private async fire(): Promise<void> {
    this.timer = null
    if (this.disposed || this.blocked || this.deps.busy()) return
    const limit = this.deps.usageLimitedUntil()
    if (limit !== null && limit > this.deps.clock.now().getTime()) {
      this.arm()
      return
    }
    try {
      if (!(await this.deps.canWake())) return
      const rows = await this.deps.repo.pending()
      if (rows.length === 0 || this.disposed) return
      this.lastStartedAt = this.deps.clock.now().getTime()
      await this.deps.wake(rows)
    } catch {
      // The rows stay pending; the next row or launch tries again.
      this.blocked = true
    }
  }
}
