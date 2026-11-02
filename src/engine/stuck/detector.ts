import type { EngineEvent } from '../../shared/api'
import type { Clock } from '../holds/clock'
import type { Repos } from '../store'
import type { StuckHit } from '../store/stuck'
import { STUCK } from './config'
import type { RunObservation } from './observation'
import { evaluate, toolKindsSeen, type RuleInput } from './rules'

export interface StuckDetectorDeps {
  repos: Pick<Repos, 'runs' | 'holds' | 'stuck'>
  /** The time the check reads; the same clock the thread's events are stamped with. */
  now: () => Date
  /** Schedules the periodic check; tests pass a fake. */
  timer: Pick<Clock, 'setTimeout' | 'clearTimeout'>
  intervalMs?: number
  emit: (e: EngineEvent) => void
  /** What the runner knows of the ticket's open run; null when it has none. */
  observe: (ticketId: string) => Promise<RunObservation | null>
  /** The newest file change in a worktree (ms since the epoch), or null. */
  newestChange: (worktreePath: string) => Promise<number | null>
}

/**
 * Looks at every open run once per interval and records what is stuck. A run that is not simply working
 * (paused, waiting on a decision, held, usage-limited, in a declared wait, with files still changing) is never
 * judged. Hits on one run grow one stuck episode; the episode closes when the agent shows progress, and when the
 * run ends (the run repository does that).
 */
export class StuckDetector {
  private timer: unknown = null
  private running: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(private readonly deps: StuckDetectorDeps) {}

  start(): void {
    this.stopped = false
    this.schedule()
  }

  /** Stops the periodic check; one under way is left to finish. */
  dispose(): void {
    this.stopped = true
    if (this.timer !== null) this.deps.timer.clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.stopped) return
    this.timer = this.deps.timer.setTimeout(async () => {
      this.timer = null
      await this.check().catch(() => {})
      this.schedule()
    }, this.deps.intervalMs ?? STUCK.checkIntervalMs)
  }

  /** One check of every open run. Checks never overlap: a second one waits for the first. */
  check(): Promise<void> {
    const run = this.running.then(() => this.checkAll())
    this.running = run.catch(() => {})
    return run
  }

  private async checkAll(): Promise<void> {
    const ticketIds = new Set((await this.deps.repos.runs.listOpen()).map((r) => r.ticketId))
    for (const ticketId of ticketIds) {
      // One ticket failing to be read (its data changing under the check) must not stop the others.
      await this.checkTicket(ticketId).catch(() => {})
    }
  }

  private async checkTicket(ticketId: string): Promise<void> {
    const obs = await this.deps.observe(ticketId)
    if (obs === null || obs.launching) return
    const { repos } = this.deps
    const now = this.deps.now().getTime()
    const open = await repos.stuck.open(obs.runId)

    if (obs.live === null) {
      await this.checkDeadProcess(obs)
      return
    }
    // The process is up again after a dead one was reported: that episode is over.
    if (open?.rule === 'dead_process') {
      await this.close(obs)
    }

    const filesChangedAt = obs.worktreePath === null ? null : await this.deps.newestChange(obs.worktreePath)
    const episode = open?.rule === 'dead_process' ? null : open
    if (episode && this.progressedSince(obs, episode.rule, Date.parse(episode.lastHitAt), filesChangedAt)) {
      await this.close(obs)
      return
    }
    if (await this.expectedQuiet(obs, now, filesChangedAt)) return

    const wait = obs.declaredWait
    const input: RuleInput = {
      now,
      events: obs.events,
      lastActivityAt: obs.live.lastActivityAt,
      startedAt: obs.live.startedAt,
      turnStartedAt: obs.live.turnStartedAt,
      inTurn: obs.live.inTurn,
      // Silence is counted from the end of a wait that has passed, so a long build isn't reported the moment it ends.
      waitEndedAt: wait === null ? null : Date.parse(wait.until),
      filesChangedAt
    }
    const hit = evaluate(input)
    if (hit === null) return
    // A repeat hit counts only after the spacing, so an episode doesn't escalate within a few minutes of a first hit.
    if (episode && now - Date.parse(episode.lastHitAt) < STUCK.hitSpacingMs) return
    await this.record(obs, hit)
  }

  /**
   * A run whose process ended on its own, not by the user's pause or a usage limit: reported once per run, on
   * the first check that sees it, and never counted again.
   */
  private async checkDeadProcess(obs: RunObservation): Promise<void> {
    const last = obs.events.at(-1)?.event
    const dead = obs.state.agentStatus === 'paused' && !obs.state.pausedByUser && last?.kind === 'process_exit'
    if (!dead || obs.usageLimited || (await this.deps.repos.holds.active('ticket', obs.ticketId))) return
    if (await this.deps.repos.stuck.hadDeadProcess(obs.runId)) return
    await this.record(obs, { rule: 'dead_process', evidence: [`The ${obs.role}'s process ended while the ticket was still running`] })
  }

  /** True while no rule may fire: the agent is not working, or silence is expected. */
  private async expectedQuiet(obs: RunObservation, now: number, filesChangedAt: number | null): Promise<boolean> {
    if (obs.state.agentStatus !== 'working' || obs.usageLimited) return true
    if (obs.declaredWait !== null && Date.parse(obs.declaredWait.until) > now) return true
    if (filesChangedAt !== null && now - filesChangedAt < STUCK.filesChangingMs) return true
    return (await this.deps.repos.holds.active('ticket', obs.ticketId)) !== null
  }

  /** True when the agent has shown progress since the episode's last hit: a new file change or kind of tool, or the rule's own cause gone. */
  private progressedSince(obs: RunObservation, rule: StuckHit['rule'], lastHitAt: number, filesChangedAt: number | null): boolean {
    if (filesChangedAt !== null && filesChangedAt > lastHitAt) return true
    if ([...toolKindsSeen(obs.events).values()].some((at) => at > lastHitAt)) return true
    const live = obs.live
    if (live === null) return false
    if (rule === 'silence') return live.lastActivityAt > lastHitAt
    if (rule === 'long_turn') return !live.inTurn || live.turnStartedAt > lastHitAt
    return false
  }

  private async record(obs: RunObservation, hit: StuckHit): Promise<void> {
    await this.deps.repos.stuck.hit(obs.runId, hit)
    this.deps.emit({ type: 'board.changed', workspaceId: obs.workspaceId })
  }

  private async close(obs: RunObservation): Promise<void> {
    if (await this.deps.repos.stuck.close(obs.runId)) this.deps.emit({ type: 'board.changed', workspaceId: obs.workspaceId })
  }
}

/** The real timer, which never keeps the process alive on its own. */
export const realTimer: StuckDetectorDeps['timer'] = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(() => void fn(), ms)
    handle.unref()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
}
