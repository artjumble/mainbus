import type { EngineEvent } from '../../shared/api'
import type { Ticket, TicketState, UnattendedState, UnattendedStatus } from '../../shared/domain'
import type { UsageLimit } from './usageLimit'

/** Keeps the machine from sleeping: Electron's powerSaveBlocker in the app. */
export interface KeepAwake {
  start(): void
  stop(): void
}

export interface UnattendedDeps {
  runner: {
    start(ticketId: string): Promise<void>
    continue(ticketId: string): Promise<void>
    stateOf(ticketId: string): Promise<TicketState>
    usageLimit(ticketId: string): UsageLimit | undefined
  }
  /** The open workspace's tickets; none without a workspace. */
  tickets: () => Promise<Ticket[]>
  /** Throws, with the reason for the user, when agents can't run (Claude Code not set up, no workspace). */
  checkCanRun: () => Promise<void>
  emit: (e: EngineEvent) => void
  keepAwake: KeepAwake
  now: () => Date
  /** How long to wait for a usage limit whose reset time is unknown. */
  retryMs?: number
}

const RETRY_MS = 15 * 60 * 1000
const MAX_FAILURES = 3
const READY_EMPTY = 'Ready is empty'

/** What became of the queue's ticket since it was started. */
type Outcome =
  | { kind: 'working' }
  /** Reached Review, or is waiting on the user in Needs you: the queue moves on. */
  | { kind: 'settled' }
  | { kind: 'failed'; error: string }
  | { kind: 'limited'; limit: UsageLimit }
  /** The user stopped it or moved it to Done. */
  | { kind: 'taken' }

/**
 * Unattended mode: starts the lowest-numbered Ready ticket, waits until it reaches Review or is blocked,
 * then starts the next, until Ready is empty. It starts one ticket at a time, through the runner's own
 * start and continue, and never merges, pushes or moves a ticket. It is driven by the engine's board events,
 * not polled, and holds the machine awake while it is on. Nothing about it persists across a restart.
 */
export class UnattendedMode {
  private on = false
  private status: UnattendedStatus = { kind: 'off' }
  /** The ticket the queue started and is waiting on. */
  private current: Ticket | null = null
  /** Failed tickets in a row. */
  private failures = 0
  /** Tickets that failed to start this session: they may still be in Ready, and are not tried again. */
  private readonly skipped = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  /** A start or continue of the queue's ticket is under way. */
  private busy = false
  private evaluating: Promise<void> | null = null
  private again = false
  private disposed = false

  constructor(private readonly deps: UnattendedDeps) {}

  isOn(): boolean {
    return this.on
  }

  get(): UnattendedState {
    return { on: this.on, status: this.status }
  }

  async set(on: boolean): Promise<UnattendedState> {
    if (on === this.on) return this.get()
    if (!on) {
      this.turnOff({ kind: 'off' })
      return this.get()
    }
    if (this.disposed) throw new Error('Mainbus is shutting down')
    await this.deps.checkCanRun()
    if (this.on) return this.get()
    this.on = true
    this.failures = 0
    this.skipped.clear()
    this.current = null
    this.deps.keepAwake.start()
    this.setStatus({ kind: 'starting' })
    this.kick()
    return this.get()
  }

  /** Called before the user's Stop reaches the runner: stopping the queue's ticket means the user is here. */
  userStopped(ticketId: string): void {
    if (this.on && this.current?.id === ticketId) this.turnOff({ kind: 'off' })
  }

  /** Sees every engine event; a board change is the cue to look at the queue's ticket again. */
  observe(e: EngineEvent): void {
    if (this.on && e.type === 'board.changed') this.kick()
  }

  dispose(): void {
    this.disposed = true
    this.turnOff({ kind: 'off' })
  }

  /** Settles when nothing is left to look at (for tests). */
  async settled(): Promise<void> {
    while (this.evaluating) await this.evaluating
  }

  // --- the queue ---

  /** Looks at the queue again; looks once more afterwards if asked meanwhile. */
  private kick(): void {
    if (this.evaluating) {
      this.again = true
      return
    }
    this.again = false
    this.evaluating = this.step()
      .catch((err: unknown) => this.turnOff({ kind: 'stopped', reason: errorText(err) }))
      .finally(() => {
        this.evaluating = null
        if (this.again && this.on) this.kick()
      })
  }

  private async step(): Promise<void> {
    if (!this.on || this.busy) return
    const current = this.current
    if (current) {
      const outcome = await this.outcomeOf(current)
      // The user may have switched the mode off, or a start may have begun, while the state was read.
      if (!this.on || this.busy || this.current !== current) return
      switch (outcome.kind) {
        case 'working':
          return
        case 'limited':
          if (this.timer === null) this.waitForLimit(current, outcome.limit)
          return
        case 'taken':
          this.turnOff({ kind: 'off' })
          return
        case 'settled':
          this.failures = 0
          this.current = null
          break
        case 'failed':
          this.current = null
          if (this.failed(outcome.error)) return
          break
      }
    }
    await this.startNext()
  }

  private async outcomeOf(ticket: Ticket): Promise<Outcome> {
    const state = await this.deps.runner.stateOf(ticket.id)
    switch (state.column) {
      case 'review':
        return { kind: 'settled' }
      case 'needs_you':
        return state.agentStatus === 'failed'
          ? { kind: 'failed', error: (state.summary ?? 'Failed').replace(/^Failed: /, '') }
          : { kind: 'settled' }
      case 'in_progress': {
        if (state.agentStatus === 'working') return { kind: 'working' }
        // Paused: the process is gone but the run is open.
        const limit = this.deps.runner.usageLimit(ticket.id)
        return limit ? { kind: 'limited', limit } : { kind: 'failed', error: 'The agent process ended unexpectedly' }
      }
      default:
        return { kind: 'taken' }
    }
  }

  private async startNext(): Promise<void> {
    const tickets = [...(await this.deps.tickets())].sort((a, b) => a.number - b.number)
    let skippedReady = false
    for (const ticket of tickets) {
      const state = await this.deps.runner.stateOf(ticket.id)
      if (!this.on || this.current !== null || this.busy) return
      if (state.column !== 'ready') continue
      if (this.skipped.has(ticket.id)) {
        skippedReady = true
        continue
      }
      this.current = ticket
      await this.launch(ticket, () => this.deps.runner.start(ticket.id), true)
      return
    }
    this.turnOff({ kind: 'stopped', reason: skippedReady ? 'No Ready ticket could be started' : READY_EMPTY })
  }

  private waitForLimit(ticket: Ticket, limit: UsageLimit): void {
    const now = this.deps.now().getTime()
    // A reset time already past would retry at once, and again, while the limit holds.
    const until = limit.resetsAt !== null && limit.resetsAt > now ? limit.resetsAt : now + (this.deps.retryMs ?? RETRY_MS)
    this.setStatus({ kind: 'waiting', ticketNumber: ticket.number, until: new Date(until).toISOString() })
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.on && this.current === ticket) void this.launch(ticket, () => this.deps.runner.continue(ticket.id), false)
    }, until - now)
  }

  /** Starts or continues the queue's ticket; a failure counts against the mode and moves the queue on. */
  private async launch(ticket: Ticket, action: () => Promise<void>, starting: boolean): Promise<void> {
    this.busy = true
    this.setStatus({ kind: 'working', ticketNumber: ticket.number })
    let error: string | null = null
    try {
      await action()
    } catch (err) {
      error = errorText(err)
    } finally {
      this.busy = false
    }
    if (error !== null && this.on && this.current === ticket) {
      // A ticket that failed to start may still be in Ready: don't pick it again.
      if (starting) this.skipped.add(ticket.id)
      this.current = null
      this.failed(error)
    }
    this.kick()
  }

  /** Counts a failed ticket; returns true when that turned the mode off. */
  private failed(error: string): boolean {
    this.failures++
    if (this.failures < MAX_FAILURES) return false
    this.turnOff({ kind: 'stopped', reason: `${MAX_FAILURES} tickets failed in a row: ${error}` })
    return true
  }

  private turnOff(status: UnattendedStatus): void {
    const wasOn = this.on
    this.on = false
    this.current = null
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (wasOn) this.deps.keepAwake.stop()
    this.setStatus(status)
  }

  private setStatus(status: UnattendedStatus): void {
    if (JSON.stringify(status) === JSON.stringify(this.status)) return
    this.status = status
    this.deps.emit({ type: 'unattended.changed', state: this.get() })
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
