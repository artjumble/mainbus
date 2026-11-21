import type { EngineEvent } from '../../shared/api'
import type { ArchiveBatch, Workspace } from '../../shared/domain'
import type { Clock } from '../holds/clock'
import type { Repos } from '../store'

export const DAY_MS = 86_400_000

/** The ISO time `days` days before now: tickets that reached Done strictly before it are "older than" that. */
export function archiveCutoff(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString()
}

export interface ArchiveSweeperDeps {
  repos: Pick<Repos, 'workspaces' | 'archive'>
  now: () => Date
  emit: (e: EngineEvent) => void
  /** Schedules the daily sweep; tests pass a fake. */
  timer: Pick<Clock, 'setTimeout' | 'clearTimeout'>
  intervalMs?: number
}

/**
 * "Archive Done tickets after": at start-up, then once a day, archives each workspace's Done tickets that are older than
 * its setting. Only Done tickets are touched, and a sweep with nothing to archive changes nothing.
 */
export class ArchiveSweeper {
  private timer: unknown = null
  private running: Promise<unknown> = Promise.resolve()
  private stopped = false

  constructor(private readonly deps: ArchiveSweeperDeps) {}

  /** Sweeps once now, then schedules the daily one. */
  async start(): Promise<void> {
    this.stopped = false
    await this.sweepAll().catch(() => {})
    this.schedule()
  }

  dispose(): void {
    this.stopped = true
    if (this.timer !== null) this.deps.timer.clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.stopped) return
    this.timer = this.deps.timer.setTimeout(async () => {
      this.timer = null
      await this.sweepAll().catch(() => {})
      this.schedule()
    }, this.deps.intervalMs ?? DAY_MS)
  }

  /** One sweep of every open workspace that has the setting on. Sweeps never overlap; one workspace failing doesn't stop the others. */
  sweepAll(): Promise<void> {
    return this.queued(async () => {
      for (const ws of await this.deps.repos.workspaces.list()) {
        if (ws.autoArchiveDays === null) continue
        await this.sweep(ws).catch(() => {})
      }
    })
  }

  /** Sweeps one workspace (when its setting was just changed); the batch it archived, or null. */
  sweepWorkspace(ws: Workspace): Promise<ArchiveBatch | null> {
    return this.queued(() => this.sweep(ws))
  }

  private queued<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.running.then(fn)
    this.running = run.catch(() => {})
    return run
  }

  private async sweep(ws: Workspace): Promise<ArchiveBatch | null> {
    if (ws.autoArchiveDays === null) return null
    const done = await this.deps.repos.archive.archiveOlder(ws.id, {
      cutoff: archiveCutoff(this.deps.now(), ws.autoArchiveDays),
      basis: 'sweep',
      olderThanDays: ws.autoArchiveDays
    })
    if (done === null) return null
    this.deps.emit({ type: 'board.changed', workspaceId: ws.id })
    return done.batch
  }
}
