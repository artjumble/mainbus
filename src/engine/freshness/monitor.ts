import type { EngineEvent } from '../../shared/api'
import type { BranchFreshness } from '../../shared/domain'
import type { Clock } from '../holds/clock'
import type { BranchFreshnessChecker } from '../git/freshness'
import type { Repos } from '../store'

/** How often open tickets are measured against the newest base. */
export const FRESHNESS_INTERVAL_MS = 5 * 60 * 1000

export interface FreshnessMonitorDeps {
  repos: Pick<Repos, 'workspaces' | 'tickets'>
  checker: BranchFreshnessChecker
  now: () => Date
  emit: (e: EngineEvent) => void
  /** Schedules the periodic check; tests pass a fake. */
  timer: Pick<Clock, 'setTimeout' | 'clearTimeout'>
  intervalMs?: number
}

/**
 * Keeps, for every open ticket with a branch, how far the branch is behind the newest base and whether merging it
 * would conflict. The answers live in memory only: they are worked out again at launch and every few minutes.
 * Nothing here changes a checkout or a branch; the fetch moves only `origin/<base>`.
 */
export class FreshnessMonitor {
  private readonly status = new Map<string, BranchFreshness>()
  private timer: unknown = null
  private running: Promise<unknown> = Promise.resolve()
  private stopped = false

  constructor(private readonly deps: FreshnessMonitorDeps) {}

  start(): void {
    this.stopped = false
    this.schedule()
  }

  /** Stops the periodic check; one under way is left to finish (see `idle`). */
  dispose(): void {
    this.stopped = true
    if (this.timer !== null) this.deps.timer.clearTimeout(this.timer)
    this.timer = null
  }

  /** Settles once the check under way, if any, has finished. */
  idle(): Promise<void> {
    return this.running.then(
      () => {},
      () => {}
    )
  }

  statusOf(ticketId: string): BranchFreshness | null {
    return this.status.get(ticketId) ?? null
  }

  private schedule(): void {
    if (this.stopped) return
    this.timer = this.deps.timer.setTimeout(async () => {
      this.timer = null
      await this.refreshAll().catch(() => {})
      this.schedule()
    }, this.deps.intervalMs ?? FRESHNESS_INTERVAL_MS)
  }

  async refreshAll(): Promise<void> {
    for (const ws of await this.deps.repos.workspaces.list()) await this.refresh(ws.id)
  }

  /** Measures every open ticket of the workspace, fetching the base first. Checks never overlap: a second one waits for the first. */
  refresh(workspaceId: string, opts: { fetch?: boolean } = {}): Promise<void> {
    const run = this.running.then(() => (this.stopped ? undefined : this.refreshNow(workspaceId, opts.fetch ?? true)))
    this.running = run.catch(() => {})
    return run
  }

  private async refreshNow(workspaceId: string, fetch: boolean): Promise<void> {
    const ws = await this.deps.repos.workspaces.get(workspaceId)
    const tickets = ws ? await this.deps.repos.tickets.list(workspaceId) : []
    const open = tickets.filter((t) => t.manualColumn !== 'done' && t.branch !== null)
    let changed = false
    // Done or removed tickets have nothing left to measure.
    for (const t of tickets) {
      if (!open.includes(t) && this.status.delete(t.id)) changed = true
    }
    if (ws && open.length > 0) {
      const base = await this.deps.checker.newestBase(ws, { fetch })
      for (const t of open) {
        let next: BranchFreshness | null = null
        try {
          const { behind, conflicts } = await this.deps.checker.check(ws.repoPath, t.branch!, base.sha)
          next = {
            baseBranch: ws.baseBranch,
            base: base.ref,
            behind,
            conflicts,
            checkedAt: this.deps.now().toISOString(),
            fetchError: base.fetchError
          }
        } catch {
          // The branch is gone or git can't answer: show nothing rather than a wrong answer.
        }
        const before = this.status.get(t.id) ?? null
        if (next === null) {
          if (this.status.delete(t.id)) changed = true
        } else {
          if (before === null || !sameAnswer(before, next)) changed = true
          this.status.set(t.id, next)
        }
      }
    }
    if (changed) this.deps.emit({ type: 'board.changed', workspaceId })
  }
}

/** Everything but the time of the check. */
function sameAnswer(a: BranchFreshness, b: BranchFreshness): boolean {
  return (
    a.baseBranch === b.baseBranch &&
    a.base === b.base &&
    a.behind === b.behind &&
    a.fetchError === b.fetchError &&
    a.conflicts.length === b.conflicts.length &&
    a.conflicts.every((f, i) => f === b.conflicts[i])
  )
}
