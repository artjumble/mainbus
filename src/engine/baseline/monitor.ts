import fs from 'node:fs/promises'
import path from 'node:path'
import type { EngineEvent } from '../../shared/api'
import type { BaseTestCommandResult, BaseTestsSummary, BaseTestsView, Workspace } from '../../shared/domain'
import { RESULTS_PLACEHOLDER } from '../../shared/domain'
import { LOCKFILES } from '../freshness/update'
import type { GitRunner } from '../git/git'
import type { NewestBase } from '../git/freshness'
import type { Clock } from '../holds/clock'
import type { SetupCommandResult, SetupCommandRunner } from '../setup/setupCommand'
import type { Repos } from '../store'
import type { BaseTestRun } from '../store/baseTests'
import type { BaselineFolder } from './folder'
import { baseTestsSummary } from './known'
import { parseResults, resultsExtension } from './results'

/** How often the newest base is looked at, and how soon a check is repeated while agents are working. */
export const BASE_TESTS_INTERVAL_MS = 5 * 60 * 1000
export const BASE_TESTS_RETRY_MS = 60 * 1000
/** A test command that outlasts this is ended. */
export const TEST_COMMAND_TIMEOUT_MS = 30 * 60 * 1000

export interface BaseTestMonitorDeps {
  repos: Pick<Repos, 'workspaces' | 'baseTests'>
  checker: { newestBase(ws: Pick<Workspace, 'repoPath' | 'baseBranch'>, opts: { fetch: boolean }): Promise<NewestBase> }
  folders: {
    ensure(ws: Pick<Workspace, 'slug' | 'repoPath'>, sha: string): Promise<BaselineFolder>
    remove(ws: Pick<Workspace, 'slug' | 'repoPath'>): Promise<void>
  }
  git: GitRunner
  /** Runs a command in the baseline folder; the same runner as the setup step. */
  commands: SetupCommandRunner
  /** True while any agent is at work: a run that is not asked for waits for them to finish. */
  agentsWorking: () => boolean
  now: () => Date
  emit: (e: EngineEvent) => void
  /** Schedules the checks; tests pass a fake. */
  timer: Pick<Clock, 'setTimeout' | 'clearTimeout'>
  intervalMs?: number
  retryMs?: number
}

interface Running {
  workspaceId: string
  controller: AbortController
  startedAt: string
  baseSha: string
  command: string | null
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The path goes in double quotes (the data home may have spaces), unless the command already quotes it. */
function withResultsPath(command: string, file: string): string {
  return command.replace(/(.?)<results>/g, (_m, before: string) => (before === '"' ? `"${file}` : `${before}"${file}"`))
}

/**
 * Keeps, for every workspace with test commands, the results of running them on the newest base branch: in a folder of
 * Mainbus's own, when the base's tip changes and no agent is working, or on demand. One run at a time, across all
 * workspaces, because tests that depend on timing compete for the processor. Nothing here touches a ticket's folder.
 */
export class BaseTestMonitor {
  private timer: unknown = null
  private chain: Promise<unknown> = Promise.resolve()
  /** Workspaces with a run queued or under way, by id: a second request for the same one is the first. */
  private readonly pending = new Map<string, Promise<void>>()
  private readonly waiting = new Set<string>()
  private running: Running | null = null
  /** The commit the setup command last ran for in each workspace's baseline folder (memory only). */
  private readonly setUpAt = new Map<string, string>()
  private stopped = false

  constructor(private readonly deps: BaseTestMonitorDeps) {}

  /** The first check comes after one retry interval, so agents that recovery restarts are counted. */
  start(): void {
    this.stopped = false
    this.schedule(this.deps.retryMs ?? BASE_TESTS_RETRY_MS, true)
  }

  /** Stops the checks and ends the command under way; a run that was cut short is not recorded. */
  dispose(): void {
    this.stopped = true
    if (this.timer !== null) this.deps.timer.clearTimeout(this.timer)
    this.timer = null
    this.running?.controller.abort()
  }

  /** Settles once the runs queued or under way have finished. */
  async idle(): Promise<void> {
    let tail: Promise<unknown>
    do {
      tail = this.chain
      await tail.then(
        () => {},
        () => {}
      )
    } while (tail !== this.chain)
  }

  /** The test commands were saved: look again soon, so a workspace that has never run starts. */
  poke(): void {
    if (this.stopped) return
    this.schedule(0, false)
  }

  /** Aborts the workspace's run and removes its baseline folder; for a removed workspace. */
  async forget(ws: Workspace): Promise<void> {
    if (this.running?.workspaceId === ws.id) this.running.controller.abort()
    await this.pending.get(ws.id)?.catch(() => {})
    this.waiting.delete(ws.id)
    this.setUpAt.delete(ws.id)
    await this.deps.folders.remove(ws)
  }

  /** Queues a run now, whatever the agents are doing. Does nothing while one for the workspace is queued or under way. */
  runNow(workspaceId: string): Promise<void> {
    return this.queue(workspaceId, 'manual')
  }

  async viewOf(workspaceId: string): Promise<BaseTestsView> {
    const ws = await this.deps.repos.workspaces.get(workspaceId)
    const runs = await this.deps.repos.baseTests.list(workspaceId)
    const running = this.running?.workspaceId === workspaceId ? this.running : null
    return {
      summary: ws ? baseTestsSummary(ws, runs) : null,
      results: runs[0]?.results ?? [],
      runs: runs.length,
      running: running ? { startedAt: running.startedAt, baseSha: running.baseSha, command: running.command } : null,
      waitingForAgents: this.waiting.has(workspaceId)
    }
  }

  /** What roles and the orchestrator are told; null when the workspace has no commands or no finished run. */
  async summaryOf(workspaceId: string): Promise<BaseTestsSummary | null> {
    const ws = await this.deps.repos.workspaces.get(workspaceId)
    if (!ws || ws.testCommands.length === 0) return null
    return baseTestsSummary(ws, await this.deps.repos.baseTests.list(workspaceId))
  }

  private schedule(ms: number, fetch: boolean): void {
    if (this.stopped) return
    if (this.timer !== null) this.deps.timer.clearTimeout(this.timer)
    this.timer = this.deps.timer.setTimeout(async () => {
      this.timer = null
      await this.check(fetch).catch(() => {})
      // While runs wait for agents, look again soon without fetching; otherwise at the normal pace.
      if (this.timer === null) {
        if (this.waiting.size > 0) this.schedule(this.deps.retryMs ?? BASE_TESTS_RETRY_MS, false)
        else this.schedule(this.deps.intervalMs ?? BASE_TESTS_INTERVAL_MS, true)
      }
    }, ms)
  }

  /** Queues a run for each workspace whose newest base has not been tested. */
  async check(fetch: boolean): Promise<void> {
    for (const ws of await this.deps.repos.workspaces.list()) {
      if (this.stopped) return
      if (ws.testCommands.length === 0 || this.pending.has(ws.id)) continue
      let base: NewestBase
      try {
        base = await this.deps.checker.newestBase(ws, { fetch })
      } catch {
        continue
      }
      const latest = await this.deps.repos.baseTests.latest(ws.id)
      if (latest !== null && latest.baseSha === base.sha) {
        if (this.waiting.delete(ws.id)) this.deps.emit({ type: 'baseTests.changed', workspaceId: ws.id })
        continue
      }
      if (this.deps.agentsWorking()) {
        if (!this.waiting.has(ws.id)) {
          this.waiting.add(ws.id)
          this.deps.emit({ type: 'baseTests.changed', workspaceId: ws.id })
        }
        continue
      }
      void this.queue(ws.id, 'base_moved')
    }
  }

  private queue(workspaceId: string, trigger: BaseTestRun['trigger']): Promise<void> {
    const queued = this.pending.get(workspaceId)
    if (queued) return queued
    const run = this.chain.then(() => this.runOne(workspaceId, trigger))
    const tracked = run.catch(() => {}).finally(() => this.pending.delete(workspaceId))
    this.pending.set(workspaceId, tracked)
    this.chain = tracked
    return tracked
  }

  private async runOne(workspaceId: string, trigger: BaseTestRun['trigger']): Promise<void> {
    if (this.stopped) return
    const ws = await this.deps.repos.workspaces.get(workspaceId)
    if (!ws || ws.testCommands.length === 0) return
    const controller = new AbortController()
    const startedAt = this.deps.now().toISOString()
    let base: NewestBase
    try {
      base = await this.deps.checker.newestBase(ws, { fetch: trigger === 'manual' })
    } catch {
      return
    }
    this.waiting.delete(workspaceId)
    this.running = { workspaceId, controller, startedAt, baseSha: base.sha, command: null }
    this.deps.emit({ type: 'baseTests.changed', workspaceId })
    let results: BaseTestCommandResult[] = []
    let error: string | null = null
    try {
      const folder = await this.deps.folders.ensure(ws, base.sha)
      error = await this.setUp(ws, folder, base.sha, controller.signal)
      if (error === null) results = await this.runCommands(ws, folder, controller.signal)
    } catch (err) {
      error = `the base branch could not be checked out: ${errorText(err)}`
    }
    try {
      // A run that was cut short (the app is closing, the workspace removed) tells nothing.
      if (controller.signal.aborted) return
      await this.deps.repos.baseTests.add({
        workspaceId,
        baseRef: base.ref,
        baseSha: base.sha,
        trigger,
        startedAt,
        endedAt: this.deps.now().toISOString(),
        error,
        results
      })
    } finally {
      this.running = null
      this.deps.emit({ type: 'baseTests.changed', workspaceId })
    }
  }

  /** Runs the workspace's setup command when the folder is new or the lockfiles moved; the reason it failed, else null. */
  private async setUp(ws: Workspace, folder: BaselineFolder, sha: string, signal: AbortSignal): Promise<string | null> {
    if (ws.setupCommand === '') return null
    const before = this.setUpAt.get(ws.id)
    const due = folder.created || before === undefined || (await this.lockfilesChanged(ws, before, sha))
    if (!due) {
      this.setUpAt.set(ws.id, sha)
      return null
    }
    this.setCommand(ws.id, 'Setup')
    const result = await this.deps.commands({
      command: ws.setupCommand,
      cwd: folder.repo,
      tempDir: folder.temp,
      timeoutMs: ws.setupTimeoutMinutes * 60_000,
      signal,
      logPath: path.join(folder.logs, 'setup.log')
    })
    if (result.aborted) return null
    if (result.timedOut || result.exitCode !== 0) {
      const why = result.timedOut ? 'timed out' : `exited with code ${result.exitCode ?? 'unknown'}`
      const last = result.tail.slice(-3).join(' | ')
      return `the setup command in the base folder ${why}${last ? `: ${last}` : ''}`
    }
    this.setUpAt.set(ws.id, sha)
    return null
  }

  private async lockfilesChanged(ws: Workspace, from: string, to: string): Promise<boolean> {
    if (from === to) return false
    try {
      return (await this.deps.git(['diff', '--quiet', from, to, '--', ...LOCKFILES], ws.repoPath)).code !== 0
    } catch {
      return true
    }
  }

  private setCommand(workspaceId: string, command: string | null): void {
    if (this.running?.workspaceId !== workspaceId) return
    this.running.command = command
    this.deps.emit({ type: 'baseTests.changed', workspaceId })
  }

  private async runCommands(ws: Workspace, folder: BaselineFolder, signal: AbortSignal): Promise<BaseTestCommandResult[]> {
    const out: BaseTestCommandResult[] = []
    for (const [i, c] of ws.testCommands.entries()) {
      if (signal.aborted) break
      this.setCommand(ws.id, c.name)
      const file = path.join(folder.results, `${i + 1}.${resultsExtension(c.format)}`)
      await fs.rm(file, { force: true })
      const started = this.deps.now().getTime()
      const ran: SetupCommandResult = await this.deps.commands({
        command: withResultsPath(c.command, file),
        cwd: folder.repo,
        tempDir: folder.temp,
        timeoutMs: TEST_COMMAND_TIMEOUT_MS,
        signal,
        logPath: path.join(folder.logs, `${i + 1}.log`)
      })
      if (ran.aborted) break
      const durationMs = Math.max(0, this.deps.now().getTime() - started)
      const failed = ran.timedOut || ran.exitCode !== 0
      let failures: string[] = []
      let note: string | null = null
      if (c.format === 'plain') {
        note = 'plain results: the exit code and the end of the output'
      } else {
        const text = await fs.readFile(file, 'utf8').catch(() => null)
        if (text === null) {
          note = `the command wrote no results file, so only its exit code and output are known`
        } else {
          const parsed = parseResults(c.format, text, folder.repo)
          if ('error' in parsed) note = parsed.error
          else failures = parsed.failures
        }
      }
      out.push({
        name: c.name,
        command: c.command,
        format: c.format,
        exitCode: ran.exitCode,
        timedOut: ran.timedOut,
        durationMs,
        failures,
        // The output's end is kept only where it is all there is to go on.
        tail: failures.length === 0 && (failed || note !== null) ? ran.tail : [],
        note
      })
    }
    this.setCommand(ws.id, null)
    return out
  }
}
