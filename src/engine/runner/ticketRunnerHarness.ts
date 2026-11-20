// Shared setup for the ticketRunner*.test.ts files: a repo, a database, a worktree manager and a ticket per test.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { EngineEvent } from '../../shared/api'
import type { Decision, Ticket } from '../../shared/domain'
import type { ThreadEvent } from '../../shared/events'
import { runGit } from '../git/git'
import { WorktreeManager } from '../git/worktrees'
import { resolveHome, type HomePaths } from '../home'
import type { Db } from '../db/open'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import { ResumeFailedError, type PermissionRequest, type RunHandle, type RunSpec } from '../runtime/types'
import { createRepos, type Repos } from '../store'
import { FIXED_NOW, implementerOnly, openTestDb } from '../store/testDb'
import { TicketRunner } from './ticketRunner'
import { type TestUsage } from './testUsage'
import { eventually } from '../testWait'

export const NUDGE =
  'You ended your turn without asking the user or handing off. If you are done, commit and call mcp__mainbus__handoff. If you need the user, call mcp__mainbus__ask_user. Otherwise continue.'

export let tmp: string
export let repoPath: string
export let paths: HomePaths
export let closeDb: () => void
export let db: Db
export let repos: Repos
export let worktrees: WorktreeManager
export let ticket: Ticket
export let emitted: EngineEvent[]
export let failures: { workspaceId: string; ticketId: string; runId: string }[]
export let runners: TicketRunner[]

export async function git(args: string[], cwd = repoPath): Promise<string> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

export async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false
  )
}

export function makeRunner(runtime: FakeRuntime, wt: WorktreeManager = worktrees, unattended = false, usage?: TestUsage): TicketRunner {
  const runner = new TicketRunner({
    repos,
    worktrees: wt,
    runtime,
    now: () => FIXED_NOW,
    emit: (e) => emitted.push(e),
    unattended: () => unattended,
    ...(usage ? { usage: usage.hooks } : {}),
    onFailed: (f) => void failures.push(f)
  })
  usage?.attach(runner)
  runners.push(runner)
  return runner
}

export const SUMMARY_USAGE = {
  kind: 'usage',
  inputTokens: 9,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  models: { m: { inputTokens: 9, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 } },
  costUsd: 0.01,
  durationMs: 50
} as const

export async function thread(): Promise<ThreadEvent[]> {
  const run = await repos.runs.latest(ticket.id)
  return run ? (await repos.runs.events(run.id)).map((e) => e.event) : []
}

export async function waitForThread(match: (e: ThreadEvent) => boolean): Promise<void> {
  await eventually(async () => expect((await thread()).some(match)).toBe(true))
}

export async function waitForPending(): Promise<Decision> {
  return eventually(async () => {
    const [d] = await repos.decisions.pending(ticket.id)
    expect(d).toBeDefined()
    return d
  })
}

export function permission(command: string): PermissionRequest {
  return { toolName: 'Bash', input: { command }, toolUseId: 'tool-1', signal: new AbortController().signal }
}

export const keepAlive: FakeStep[] = [{ waitForSend: true }]

/** A FakeRuntime whose start() waits until the test opens the gate, like a resume waiting for system/init. */
export class SlowRuntime extends FakeRuntime {
  startCalls = 0
  private notifyStart: () => void = () => {}
  /** Resolves when start() is first called (it then waits at the gate): an event to await instead of polling startCalls. */
  readonly firstStart = new Promise<void>((resolve) => (this.notifyStart = resolve))
  readonly stoppedHandles: string[] = []
  private release: () => void = () => {}
  private readonly gate = new Promise<void>((resolve) => (this.release = resolve))

  open(): void {
    this.release()
  }

  constructor(
    script: FakeStep[],
    /** Like SdkRuntime when system/init never comes: a resume rejects once the gate opens. */
    private readonly resumeTimesOut = false
  ) {
    super(script)
  }

  override async start(spec: RunSpec): Promise<RunHandle> {
    this.startCalls++
    this.notifyStart()
    await this.gate
    if (this.resumeTimesOut && spec.resumeSessionId) {
      throw new ResumeFailedError('Could not resume the previous session: no system/init within 60000 ms')
    }
    return super.start(spec)
  }

  override async stop(handle: RunHandle): Promise<void> {
    this.stoppedHandles.push(handle.id)
    return super.stop(handle)
  }
}

/** Plays a first run that records a session, optionally asks a question, and exits: the ticket is then paused. */
export async function pausedRun(opts: { ask?: boolean } = {}): Promise<void> {
  const ask: FakeStep[] = opts.ask
    ? [{ callTool: 'askUser', args: { question: 'Which API?', options: ['Old API', 'New API'] } }]
    : []
  const before = makeRunner(
    new FakeRuntime([
      { emit: { kind: 'session', sessionId: 'session-1' } },
      ...ask,
      { emit: { kind: 'turn_end', ok: true } },
      { exit: 0 }
    ])
  )
  await before.start(ticket.id)
  await waitForThread((e) => e.kind === 'process_exit')
}

/** A WorktreeManager whose ensure() waits until the test opens the gate (slow worktree setup). */
export class SlowWorktrees extends WorktreeManager {
  ensureCalls = 0
  private release: () => void = () => {}
  private readonly gate = new Promise<void>((resolve) => (this.release = resolve))

  open(): void {
    this.release()
  }

  override async ensure(...args: Parameters<WorktreeManager['ensure']>): ReturnType<WorktreeManager['ensure']> {
    this.ensureCalls++
    await this.gate
    return super.ensure(...args)
  }
}

export function count(events: ThreadEvent[], kind: ThreadEvent['kind']): number {
  return events.filter((e) => e.kind === kind).length
}

/** Records every handle passed to stop(), on top of FakeRuntime's own records. */
export class StopRecording extends FakeRuntime {
  readonly stopped: string[] = []
  override async stop(handle: RunHandle): Promise<void> {
    this.stopped.push(handle.id)
    return super.stop(handle)
  }
}

/** Registers the shared per-test setup and teardown in the calling test file. */
export function installRunnerHooks(): void {
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-runner-'))
    repoPath = path.join(tmp, 'repo')
    await fs.mkdir(repoPath)
    await git(['init', '-b', 'main'])
    await fs.writeFile(path.join(repoPath, 'README.md'), 'hello\n')
    await git(['add', '.'])
    await git(['commit', '-m', 'initial'])

    paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
    const testDb = await openTestDb()
    closeDb = testDb.cleanup
    db = testDb.db
    repos = createRepos(testDb.db, () => FIXED_NOW)
    worktrees = new WorktreeManager(runGit, paths, repos.cleanups)
    const ws = await repos.workspaces.create(repoPath, 'main', 'repo', 'repo')
    // Most tests here are about one role; the lineup tests set their own roles.
    await implementerOnly(repos.lineups, ws.id)
    ticket = await repos.tickets.create({
      workspaceId: ws.id,
      title: 'Rate-limit login',
      intent: 'Limit login attempts to five a minute',
      spec: '',
      criteria: [],
      labels: [],
      column: 'ready'
    })
    emitted = []
    failures = []
    runners = []
  })

  afterEach(async () => {
    for (const runner of runners) await runner.stop(ticket.id).catch(() => {})
    closeDb()
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
  })
}
