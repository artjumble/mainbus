import type { EngineEvent } from '../../shared/api'
import type { Ticket, TicketState, UnattendedState, UnattendedStatus } from '../../shared/domain'

/** Keeps the machine from sleeping: Electron's powerSaveBlocker in the app. */
export interface KeepAwake {
  start(): void
  stop(): void
}

export interface UnattendedDeps {
  runner: {
    start(ticketId: string): Promise<void>
    stateOf(ticketId: string): Promise<TicketState>
    /** A launch is in flight, possibly before the ticket's run exists. */
    isLaunching(ticketId: string): boolean
  }
  /** The open workspace's tickets; none without a workspace. */
  tickets: () => Promise<Ticket[]>
  /** The ids of the held tickets: a held ticket in Ready is not started. */
  held?: () => Promise<Set<string>>
  /** Throws, with the reason for the user, when agents can't run (Claude Code not set up, no workspace). */
  checkCanRun: () => Promise<void>
  emit: (e: EngineEvent) => void
  keepAwake: KeepAwake
  now: () => Date
  /** Stores whether the mode is on, so it comes back after a restart. */
  remember?: (on: boolean) => Promise<void>
  /** Whether the mode was on when the app last ran. */
  remembered?: () => Promise<boolean>
  /** While the app-wide usage limit holds: when it resets or is tried again (ms since the epoch); otherwise null. */
  limitedUntil: () => number | null
}

const MAX_FAILURES = 3

/** What became of the queue's ticket since it was started. */
type Outcome =
  | { kind: 'working' }
  /** Reached Review, or is waiting on the user in Needs you: the queue moves on. */
  | { kind: 'settled' }
  | { kind: 'failed'; error: string }
  | { kind: 'limited' }
  /** The user stopped it or moved it to Done. */
  | { kind: 'taken' }

/**
 * Unattended mode: starts the lowest-numbered Ready ticket that isn't held, waits until it reaches Review or is blocked,
 * then starts the next. With Ready empty it stays on and waits for a ticket to arrive there. It starts a
 * ticket only while no ticket in the workspace is working, its own or one started by hand, through the
 * runner's own start, and never merges, pushes or moves a ticket. It is driven by the engine's
 * board events, not polled, and holds the machine awake only while a ticket is working or a usage limit is
 * being waited out. Whether it is on is remembered across a restart (see restore); quitting leaves it on.
 */
export class UnattendedMode {
  private on = false
  /** The keep-awake is held. */
  private awake = false
  private status: UnattendedStatus = { kind: 'off' }
  /** The ticket the queue started and is waiting on. */
  private current: Ticket | null = null
  /** Failed tickets in a row. */
  private failures = 0
  /** Tickets that failed to start this session: they may still be in Ready, and are not tried again. */
  private readonly skipped = new Set<string>()
  /** Tickets the user stopped (back in Ready): not started again until the user moves them to Ready. */
  private readonly setAside = new Set<string>()
  /** A start of the queue's ticket is under way. */
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
    this.setAside.clear()
    this.current = null
    this.remember(true)
    this.setStatus({ kind: 'starting' })
    this.kick()
    return this.get()
  }

  /**
   * Called once after the app has recovered its agents: turns the mode back on when it was on at quit. If agents can't
   * run now, it stays off, says why, and is forgotten. The agents that came back count as other tickets working.
   */
  async restore(): Promise<void> {
    if (this.on || this.disposed || !(await this.deps.remembered?.())) return
    try {
      await this.set(true)
    } catch (err) {
      this.remember(false)
      this.setStatus({ kind: 'stopped', reason: errorText(err) })
    }
  }

  /**
   * Called before the user's Stop reaches the runner: stopping the queue's ticket means the user is here.
   * Any other stopped ticket goes back to Ready, where the queue must not pick it straight up again.
   */
  userStopped(ticketId: string): void {
    if (!this.on) return
    if (this.current?.id === ticketId) this.turnOff({ kind: 'off' })
    else this.setAside.add(ticketId)
  }

  /**
   * Called before the user's Pause reaches the runner: pausing the queue's ticket means the user is here, as Stop
   * does. Any other paused ticket stays in progress and is not working, so the queue may start the next one.
   */
  userPaused(ticketId: string): void {
    if (this.on && this.current?.id === ticketId) this.turnOff({ kind: 'off' })
  }

  /** Called before the user's move reaches the runner: a ticket the user puts in Ready may be started again. */
  userMoved(ticketId: string, column: string): void {
    if (column === 'ready') this.setAside.delete(ticketId)
  }

  /** Sees every engine event; a board change is the cue to look at the queue's ticket again. */
  observe(e: EngineEvent): void {
    if (this.on && e.type === 'board.changed') this.kick()
  }

  dispose(): void {
    this.disposed = true
    // Quitting is not the user switching it off: it stays remembered as on.
    this.turnOff({ kind: 'off' }, false)
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
          this.setStatus({ kind: 'working', ticketNumber: current.number })
          this.keepAwake(true)
          return
        case 'limited':
          // The shared usage limit resumes the ticket by itself at the reset; the board changing moves the mode on.
          this.waitForLimit(current)
          this.keepAwake(true)
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
        // Queued counts as working: it starts when a slot frees up, and the queue waits for it like any other ticket.
        if (state.agentStatus === 'working' || state.agentStatus === 'queued') return { kind: 'working' }
        // A deferred decision: the user will answer it later; the queue moves on.
        if (state.agentStatus === 'waiting_on_you') return { kind: 'settled' }
        // Paused by the usage limit: the app resumes it at the reset.
        if (state.pausedByLimit) return { kind: 'limited' }
        // Paused otherwise: the process is gone but the run is open.
        return { kind: 'failed', error: 'The agent process ended unexpectedly' }
      }
      default:
        return { kind: 'taken' }
    }
  }

  /** Starts the lowest-numbered Ready ticket, unless some ticket is working; otherwise waits for the board to change. */
  private async startNext(): Promise<void> {
    const tickets = [...(await this.deps.tickets())].sort((a, b) => a.number - b.number)
    const held = (await this.deps.held?.()) ?? new Set<string>()
    let next: Ticket | null = null
    let skippedReady = false
    for (const ticket of tickets) {
      const state = await this.deps.runner.stateOf(ticket.id)
      if (!this.on || this.current !== null || this.busy) return
      if ((state.column === 'in_progress' && (state.agentStatus === 'working' || state.agentStatus === 'queued' || state.pausedByLimit)) || this.deps.runner.isLaunching(ticket.id)) {
        this.setStatus({ kind: 'other_working', ticketNumber: ticket.number })
        this.keepAwake(true)
        return
      }
      if (state.column !== 'ready') continue
      if (this.setAside.has(ticket.id) || held.has(ticket.id)) continue
      if (this.skipped.has(ticket.id)) skippedReady = true
      else next ??= ticket
    }
    if (next === null) {
      this.setStatus(skippedReady ? { kind: 'idle', skipped: true } : { kind: 'idle' })
      this.keepAwake(false)
      return
    }
    this.current = next
    const ticket = next
    await this.launch(ticket, () => this.deps.runner.start(ticket.id))
  }

  /** Says the mode is waiting for the usage limit's reset (or the next try, when the reset is unknown). */
  private waitForLimit(ticket: Ticket): void {
    const until = this.deps.limitedUntil() ?? this.deps.now().getTime()
    this.setStatus({ kind: 'waiting', ticketNumber: ticket.number, until: new Date(until).toISOString() })
  }

  /** Starts the queue's ticket; a failure counts against the mode and moves the queue on. */
  private async launch(ticket: Ticket, action: () => Promise<void>): Promise<void> {
    this.busy = true
    this.setStatus({ kind: 'working', ticketNumber: ticket.number })
    this.keepAwake(true)
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
      this.skipped.add(ticket.id)
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

  private turnOff(status: UnattendedStatus, forget = true): void {
    if (this.on && forget) this.remember(false)
    this.on = false
    this.current = null
    this.keepAwake(false)
    this.setStatus(status)
  }

  private remember(on: boolean): void {
    void this.deps.remember?.(on).catch(() => {})
  }

  /** Holds the machine awake while there is work, and lets it sleep while the mode is idle or off. */
  private keepAwake(held: boolean): void {
    if (held === this.awake) return
    this.awake = held
    if (held) this.deps.keepAwake.start()
    else this.deps.keepAwake.stop()
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
