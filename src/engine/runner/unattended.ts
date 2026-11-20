import type { EngineEvent } from '../../shared/api'
import type { Ticket, TicketState, UnattendedState, UnattendedStatus } from '../../shared/domain'

/** Keeps the machine from sleeping: Electron's powerSaveBlocker in the app. */
export interface KeepAwake {
  start(): void
  stop(): void
}

export interface UnattendedDeps {
  /** The workspace this mode works: it starts only its tickets and hears only its board's changes. */
  workspaceId: string
  runner: {
    start(ticketId: string): Promise<void>
    stateOf(ticketId: string): Promise<TicketState>
    /** A launch is in flight, possibly before the ticket's run exists. */
    isLaunching(ticketId: string): boolean
  }
  /** The workspace's tickets. */
  tickets: () => Promise<Ticket[]>
  /** The ids of the held tickets: a held ticket in Ready is not started. */
  held?: () => Promise<Set<string>>
  /** The ids of the blocked tickets (a blocker isn't Done): a blocked ticket in Ready is not started either. */
  blocked?: () => Promise<Set<string>>
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
  /** How many of the workspace's tickets the mode keeps working at once ("Unattended: tickets at once"); 1 when absent. */
  atOnce?: () => Promise<number>
}

const MAX_FAILURES = 3

/** What became of a ticket the mode started, since it was started. */
type Outcome =
  | { kind: 'working' }
  /** Reached Review, or is waiting on the user in Needs you: its place is free again. */
  | { kind: 'settled' }
  | { kind: 'failed'; error: string }
  | { kind: 'limited' }
  /** The user stopped it or moved it to Done. */
  | { kind: 'taken' }

/**
 * Unattended mode of one workspace: keeps up to N tickets working (N is "Unattended: tickets at once", 1 by default),
 * starting the lowest-numbered Ready tickets that aren't held or blocked. A ticket stops counting once it reaches Review,
 * is waiting on the user in Needs you, fails, or is stopped or paused; that frees a place for the next. Tickets started by
 * hand count toward N, and nothing new starts while a usage limit holds. With Ready empty it stays on and waits for a
 * ticket to arrive there. It starts tickets through the runner's own start, and never merges, pushes or moves a ticket.
 * It is driven by the engine's board events, not polled, and holds the machine awake only while a ticket is working or a
 * usage limit is being waited out. Whether it is on is remembered across a restart (see restore); quitting leaves it on.
 * At N = 1, stopping or pausing its ticket means the user is here and switches it off; above 1 that only frees the place.
 */
export class UnattendedMode {
  private on = false
  /** The keep-awake is held. */
  private awake = false
  private status: UnattendedStatus = { kind: 'off' }
  /** The tickets the mode started and is waiting on, by id. */
  private readonly mine = new Map<string, Ticket>()
  /** The ids among them whose start is still under way. */
  private readonly starting = new Set<string>()
  private readonly launches = new Set<Promise<void>>()
  /** The latest N seen, for the synchronous user hooks. */
  private atOnce = 1
  /** Failed tickets in a row. */
  private failures = 0
  /** Tickets that failed to start this session: they may still be in Ready, and are not tried again. */
  private readonly skipped = new Set<string>()
  /** Tickets the user stopped (back in Ready): not started again until the user moves them to Ready. */
  private readonly setAside = new Set<string>()
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
    this.mine.clear()
    this.starting.clear()
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
   * Called before the user's Stop reaches the runner. At N = 1, stopping the mode's ticket means the user is here, so the
   * mode switches off; above 1 it only frees the place. Any stopped ticket goes back to Ready, where the mode must not
   * pick it straight up again.
   */
  userStopped(ticketId: string): void {
    if (!this.on) return
    if (this.mine.has(ticketId)) {
      if (this.atOnce <= 1) {
        this.turnOff({ kind: 'off' })
        return
      }
      this.mine.delete(ticketId)
    }
    this.setAside.add(ticketId)
  }

  /**
   * Called before the user's Pause reaches the runner: as Stop does, it switches the mode off at N = 1 and otherwise
   * only frees the place. Any other paused ticket stays in progress and is not working, so the mode may start the next.
   */
  userPaused(ticketId: string): void {
    if (!this.on || !this.mine.has(ticketId)) return
    if (this.atOnce <= 1) this.turnOff({ kind: 'off' })
    else this.mine.delete(ticketId)
  }

  /** Called before the user's move reaches the runner: a ticket the user puts in Ready may be started again. */
  userMoved(ticketId: string, column: string): void {
    if (column === 'ready') this.setAside.delete(ticketId)
  }

  /** Sees every engine event; a board change is the cue to look at the queue again. */
  observe(e: EngineEvent): void {
    if (this.on && e.type === 'board.changed' && e.workspaceId === this.deps.workspaceId) this.kick()
  }

  dispose(): void {
    this.disposed = true
    // Quitting is not the user switching it off: it stays remembered as on.
    this.turnOff({ kind: 'off' }, false)
  }

  /** Settles when nothing is left to look at and no start is under way (for tests). */
  async settled(): Promise<void> {
    while (this.evaluating || this.launches.size > 0) await Promise.all([this.evaluating, ...this.launches])
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
    if (!this.on) return
    const atOnce = Math.max(1, Math.floor((await this.deps.atOnce?.()) ?? 1))
    this.atOnce = atOnce
    if (!this.on) return
    let mineLimited = false
    for (const ticket of [...this.mine.values()]) {
      // A start under way counts as working; the runner's state isn't settled yet.
      if (this.starting.has(ticket.id)) continue
      const outcome = await this.outcomeOf(ticket)
      // The user may have switched the mode off, or taken the ticket, while the state was read.
      if (!this.on) return
      if (this.mine.get(ticket.id) !== ticket || this.starting.has(ticket.id)) continue
      switch (outcome.kind) {
        case 'working':
          break
        case 'limited':
          // The shared usage limit resumes the ticket by itself at the reset; the board changing moves the mode on.
          mineLimited = true
          break
        case 'taken':
          if (atOnce <= 1) {
            this.turnOff({ kind: 'off' })
            return
          }
          this.mine.delete(ticket.id)
          break
        case 'settled':
          this.failures = 0
          this.mine.delete(ticket.id)
          break
        case 'failed':
          this.mine.delete(ticket.id)
          if (this.failed(outcome.error)) return
          break
      }
    }
    await this.fill(atOnce, mineLimited)
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

  /** Fills the free places with the lowest-numbered startable Ready tickets, unless a usage limit holds; then says what it is doing. */
  private async fill(atOnce: number, mineLimited: boolean): Promise<void> {
    const tickets = [...(await this.deps.tickets())].sort((a, b) => a.number - b.number)
    const held = (await this.deps.held?.()) ?? new Set<string>()
    const blocked = (await this.deps.blocked?.()) ?? new Set<string>()
    const others: number[] = []
    const candidates: Ticket[] = []
    let othersLimited = false
    let skippedReady = false
    for (const ticket of tickets) {
      if (this.mine.has(ticket.id)) continue
      const state = await this.deps.runner.stateOf(ticket.id)
      if (!this.on) return
      if (this.mine.has(ticket.id)) continue
      if ((state.column === 'in_progress' && (state.agentStatus === 'working' || state.agentStatus === 'queued' || state.pausedByLimit)) || this.deps.runner.isLaunching(ticket.id)) {
        others.push(ticket.number)
        if (state.pausedByLimit) othersLimited = true
        continue
      }
      if (state.column !== 'ready') continue
      if (this.setAside.has(ticket.id) || held.has(ticket.id) || blocked.has(ticket.id)) continue
      if (this.skipped.has(ticket.id)) skippedReady = true
      else candidates.push(ticket)
    }
    const limitUntil = this.deps.limitedUntil()
    const holding = mineLimited || othersLimited || limitUntil !== null
    if (!holding) {
      const free = atOnce - this.mine.size - others.length
      for (const ticket of candidates.slice(0, Math.max(0, free))) {
        this.mine.set(ticket.id, ticket)
        this.starting.add(ticket.id)
        this.launch(ticket)
      }
    }
    const mine = [...this.mine.values()].map((t) => t.number).sort((a, b) => a - b)
    if (mine.length > 0 && !mineLimited) {
      this.setStatus({ kind: 'working', ticketNumbers: mine })
      this.keepAwake(true)
    } else if (mineLimited || (limitUntil !== null && !othersLimited)) {
      this.setStatus({ kind: 'waiting', until: new Date(limitUntil ?? this.deps.now().getTime()).toISOString() })
      this.keepAwake(true)
    } else if (others.length > 0) {
      this.setStatus({ kind: 'other_working', ticketNumbers: others.sort((a, b) => a - b) })
      this.keepAwake(true)
    } else if (limitUntil !== null) {
      this.setStatus({ kind: 'waiting', until: new Date(limitUntil).toISOString() })
      this.keepAwake(true)
    } else {
      this.setStatus(skippedReady ? { kind: 'idle', skipped: true } : { kind: 'idle' })
      this.keepAwake(false)
    }
  }

  /** Starts one ticket without waiting for it in the queue; a failure counts against the mode and frees the place. */
  private launch(ticket: Ticket): void {
    const run: Promise<void> = (async () => {
      let error: string | null = null
      try {
        await this.deps.runner.start(ticket.id)
      } catch (err) {
        error = errorText(err)
      } finally {
        this.starting.delete(ticket.id)
      }
      if (error !== null && this.on && this.mine.get(ticket.id) === ticket) {
        // A ticket that failed to start may still be in Ready: don't pick it again.
        this.skipped.add(ticket.id)
        this.mine.delete(ticket.id)
        this.failed(error)
      }
      this.kick()
    })().finally(() => this.launches.delete(run))
    this.launches.add(run)
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
    this.mine.clear()
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
    this.deps.emit({ type: 'unattended.changed', workspaceId: this.deps.workspaceId, state: this.get() })
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
