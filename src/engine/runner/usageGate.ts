import type { EngineEvent } from '../../shared/api'
import type { UsageState } from '../../shared/domain'
import type { AgentEvent } from '../../shared/events'
import { usagePauseReason } from '../../shared/usage'
import { MAX_TIMER_MS, type Clock } from '../holds/clock'
import type { SettingsRepo } from '../store/settings'
import type { UsageHooks } from './ticketRunner'
import { limitFromEvent, type UsageLimit } from './usageLimit'

/** How long to wait before trying again when a usage limit has no known reset. */
export const USAGE_RETRY_MS = 15 * 60 * 1000
/** A window this used up (0 to 1) holds new agents back. */
export const WARNING_UTILIZATION = 0.9
/** The name of the pseudo-window an `allowed_warning` stands for when no window shows its utilization. */
const SDK_WINDOW = 'sdk'

export interface UsageGateDeps {
  settings: Pick<SettingsRepo, 'usageLimit' | 'setUsageLimit'>
  clock: Clock
  emit: (e: EngineEvent) => void
  /** How long to wait before trying again when the reset is unknown (tests shorten it). */
  retryMs?: number
  runner: {
    /** Pauses the working agents (the one that hit the limit first); the part that matters happens before it returns. */
    pauseForUsageLimit(firstRunId: string | null): void
    /** Puts the agents the limit paused at the front of the queue, in the order they were paused, and starts the queue. */
    releaseLimitPaused(): Promise<void>
    /** Resumes the first agent the limit paused, past the gate. False when an earlier probe is still running. */
    probe(): Promise<boolean>
    limitPausedCount(): Promise<number>
    kickQueue(): void
  }
}

/** The gate as the runner sees it. */
export function usageHooks(gate: UsageGate): UsageHooks {
  return {
    limited: () => gate.isLimited(),
    blocksStarts: () => gate.blocksStarts(),
    pauseReason: () => gate.pauseReason(),
    rateLimit: (event, runId) => gate.rateLimit(event, runId),
    hit: (limit, runId) => gate.hit(limit, runId),
    gotThrough: () => gate.gotThrough(),
    changed: () => void gate.publish()
  }
}

/**
 * The app-wide usage limit. While limited, every working agent is paused, nothing starts, and the agents come back in
 * order at the reset (or one at a time every 15 minutes when the reset is unknown). Close to the limit, new agents
 * wait as Queued while running ones go on. The limited state is stored, so it survives a restart.
 */
export class UsageGate {
  private limited: { since: string; resetsAt: number | null } | null = null
  /** When the next try is made, while limited with no known reset. */
  private retryAt: number | null = null
  /** The windows close to their limit, and when each resets (ms since the epoch). */
  private readonly windows = new Map<string, number>()
  private timer: unknown = null
  private warningTimer: unknown = null
  private disposed = false

  constructor(private readonly deps: UsageGateDeps) {}

  private get retryMs(): number {
    return this.deps.retryMs ?? USAGE_RETRY_MS
  }

  private now(): number {
    return this.deps.clock.now().getTime()
  }

  /** Reads the stored state. Before recovery, so the queue is blocked from the start. */
  async load(): Promise<void> {
    const stored = await this.deps.settings.usageLimit()
    if (!stored) return
    const since = Date.parse(stored.since)
    const resetsAt = stored.resetsAt === null ? null : Date.parse(stored.resetsAt)
    this.limited = { since: stored.since, resetsAt: resetsAt !== null && !Number.isNaN(resetsAt) ? resetsAt : null }
    if (this.limited.resetsAt === null) this.retryAt = (Number.isNaN(since) ? this.now() : since) + this.retryMs
  }

  /** After recovery: ends a limit whose reset passed, releases marks left without a state, and arms the timers. */
  async start(): Promise<void> {
    if (this.disposed) return
    if (this.limited) {
      if (this.limited.resetsAt !== null && this.limited.resetsAt <= this.now()) await this.end()
      else {
        if (this.retryAt !== null) this.retryAt = Math.max(this.retryAt, this.now())
        this.arm()
      }
      return
    }
    if ((await this.deps.runner.limitPausedCount()) > 0) await this.deps.runner.releaseLimitPaused()
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
    if (this.warningTimer !== null) this.deps.clock.clearTimeout(this.warningTimer)
    this.warningTimer = null
  }

  isLimited(): boolean {
    return this.limited !== null
  }

  /** True while no new agent may start: limited, or close to the limit. */
  blocksStarts(): boolean {
    return this.limited !== null || this.windows.size > 0
  }

  /** When the limit is expected to lift or be tried again (ms since the epoch); null when not limited. */
  limitedUntil(): number | null {
    return this.limited ? (this.limited.resetsAt ?? this.retryAt) : null
  }

  /** What a paused agent's card says; empty when not limited. */
  pauseReason(): string {
    if (!this.limited) return ''
    return usagePauseReason({
      kind: 'limited',
      resetsAt: this.limited.resetsAt === null ? null : new Date(this.limited.resetsAt).toISOString(),
      retryAt: this.retryAt === null ? null : new Date(this.retryAt).toISOString(),
      paused: 0
    })
  }

  async state(): Promise<UsageState> {
    if (this.limited) {
      return {
        kind: 'limited',
        resetsAt: this.limited.resetsAt === null ? null : new Date(this.limited.resetsAt).toISOString(),
        retryAt: this.retryAt === null ? null : new Date(this.retryAt).toISOString(),
        paused: await this.deps.runner.limitPausedCount()
      }
    }
    if (this.windows.size > 0) {
      return { kind: 'warning', resetsAt: new Date(Math.max(...this.windows.values())).toISOString() }
    }
    return { kind: 'ok' }
  }

  /** Tells the renderer where things stand now. */
  async publish(): Promise<void> {
    if (this.disposed) return
    const state = await this.state().catch(() => null)
    if (state) this.deps.emit({ type: 'usage.changed', state })
  }

  /**
   * An agent or the orchestrator ran into the usage limit: the app is limited (or, if it already was, waits again),
   * and every working agent is paused. A reset time that has already passed counts as unknown.
   */
  hit(limit: UsageLimit, runId: string | null): void {
    if (this.disposed) return
    const now = this.now()
    const resetsAt = limit.resetsAt !== null && limit.resetsAt > now ? limit.resetsAt : null
    const old = this.limited
    const known = resetsAt !== null && old?.resetsAt != null ? Math.max(resetsAt, old.resetsAt) : (resetsAt ?? old?.resetsAt ?? null)
    this.limited = { since: old?.since ?? new Date(now).toISOString(), resetsAt: known !== null && known > now ? known : null }
    this.retryAt = this.limited.resetsAt === null ? now + this.retryMs : null
    // The agents stop before anything else can happen to them (their own turn ending, say).
    this.deps.runner.pauseForUsageLimit(runId)
    this.arm()
    void this.persist().then(() => this.publish())
  }

  /** A `rate_limit` event: a rejected one is a limit; the others show how close the windows are. */
  rateLimit(event: Extract<AgentEvent, { kind: 'rate_limit' }>, runId: string | null): void {
    const limit = limitFromEvent(event)
    if (limit) {
      this.hit(limit, runId)
      return
    }
    const before = this.windows.size
    let anyHigh = false
    for (const [name, w] of Object.entries(event.windows)) {
      if (typeof w.utilization !== 'number') continue
      if (w.utilization >= WARNING_UTILIZATION) {
        anyHigh = true
        this.windows.set(name, w.resetsAt * 1000)
      } else this.windows.delete(name)
    }
    if (event.status === 'allowed_warning' && !anyHigh && this.windows.size === 0) {
      this.windows.set(SDK_WINDOW, event.resetsAt !== undefined ? event.resetsAt * 1000 : this.now() + this.retryMs)
    } else if (event.status === 'allowed' || anyHigh) this.windows.delete(SDK_WINDOW)
    this.dropExpired()
    this.armWarning()
    if (this.windows.size === 0 && before > 0) this.deps.runner.kickQueue()
    if (this.windows.size > 0 || before > 0) void this.publish()
  }

  /** An agent that was let through the gate got an answer from the API: the limit is over. */
  gotThrough(): void {
    if (this.limited) void this.end()
  }

  /** The user's Resume now. */
  async resumeNow(): Promise<void> {
    if (this.limited) await this.end()
    else if (this.windows.size > 0) {
      this.windows.clear()
      this.armWarning()
      this.deps.runner.kickQueue()
      await this.publish()
    }
  }

  private async end(): Promise<void> {
    if (!this.limited) return
    this.limited = null
    this.retryAt = null
    this.clearTimer()
    await this.persist()
    await this.deps.runner.releaseLimitPaused()
    await this.publish()
  }

  private async persist(): Promise<void> {
    const l = this.limited
    await this.deps.settings
      .setUsageLimit(l ? { since: l.since, resetsAt: l.resetsAt === null ? null : new Date(l.resetsAt).toISOString() } : null)
      .catch(() => {})
  }

  // --- timers ---

  private clearTimer(): void {
    if (this.timer !== null) this.deps.clock.clearTimeout(this.timer)
    this.timer = null
  }

  /** Waits for the reset, or for the next try when the reset is unknown. */
  private arm(): void {
    this.clearTimer()
    if (this.disposed || !this.limited) return
    const at = this.limited.resetsAt ?? this.retryAt ?? this.now() + this.retryMs
    this.timer = this.deps.clock.setTimeout(() => this.fire(at), Math.min(MAX_TIMER_MS, Math.max(0, at - this.now())))
  }

  private async fire(at: number): Promise<void> {
    this.timer = null
    if (this.disposed || !this.limited) return
    if (this.now() < at) return this.arm()
    if (this.limited.resetsAt !== null) return this.end()
    // No reset time known: if nothing is paused any more there is nothing to wait for; else one agent tries.
    if ((await this.deps.runner.limitPausedCount()) === 0) return this.end()
    await this.deps.runner.probe().catch(() => false)
    if (!this.limited) return
    this.retryAt = this.now() + this.retryMs
    this.arm()
    await this.publish()
  }

  private dropExpired(): void {
    const now = this.now()
    for (const [name, at] of this.windows) if (at <= now) this.windows.delete(name)
  }

  /** Waits for the earliest window to reset; the warning clears when the last one has. */
  private armWarning(): void {
    if (this.warningTimer !== null) this.deps.clock.clearTimeout(this.warningTimer)
    this.warningTimer = null
    if (this.disposed || this.windows.size === 0) return
    const at = Math.min(...this.windows.values())
    this.warningTimer = this.deps.clock.setTimeout(() => {
      this.warningTimer = null
      if (this.now() < at) return this.armWarning()
      const had = this.windows.size
      this.dropExpired()
      this.armWarning()
      if (this.windows.size === 0 && had > 0) this.deps.runner.kickQueue()
      void this.publish()
    }, Math.min(MAX_TIMER_MS, Math.max(0, at - this.now())))
  }
}
