import fs from 'node:fs/promises'
import path from 'node:path'
import type { EngineEvent } from '../../shared/api'
import {
  ANSWERED_VIA,
  type CardVia,
  type DeclaredWait,
  type Decision,
  type DecisionAnswer,
  type Effort,
  type LineupRole,
  type Phase,
  type StartOptions,
  type StripRole,
  type Ticket,
  type TicketKind,
  type TicketSetup,
  type BaseTestsSummary,
  type TicketState,
  type Workspace
} from '../../shared/domain'
import type { AgentEvent, StoredEvent, ThreadEvent, ThreadRun, UsageEvent } from '../../shared/events'
import { defaultFor, EFFORTS, EXTRA_INSTRUCTIONS_MAX, modelAllowed, resolveModelEffort } from '../../shared/models'
import { applyRunSettings } from '../../shared/runSettings'
import { clockTime } from '../../shared/waiting'
import { sessionUsageSoFar } from '../../shared/usageTotals'
import { USAGE_PAUSED_PREFIX } from '../../shared/usage'
import type { PublishInput, PublishResult } from '../git/pullRequests'
import {
  investigationTitle,
  reportDate,
  reportFilePath,
  reportFileText,
  type SaveReportInput,
  type SaveReportResult
} from '../git/reportFiles'
import type { LeftoverFolder, WorktreeManager } from '../git/worktrees'
import { endedNotice, type ProcessRef, type ProcessSweeper } from '../processes/sweep'
import { credentialReason } from '../permissions/credentials'
import { guardReason } from '../permissions/guard'
import { BACKGROUND_DENIED, commandOf, describeRequest, isAllowed, isBackgroundShell, isDestructivePush, isShellTool, requestParts, rulesFromRequest } from '../permissions/policy'
import { parseShell } from '../permissions/shell'
import { DISALLOWED_TOOLS } from '../roles/hardening'
import type { BranchChanges } from '../git/changedFiles'
import { buildRolePrompt, data, firstMessage, oneLine, type EarlierHandoff, type PromptAttachment } from '../roles/prompt'
import {
  ResumeFailedError,
  type AgentRuntime,
  type PermissionRequest,
  type PermissionVerdict,
  type RoleToolHandlers,
  type RunHandle,
  type RunSpec,
  type SpawnedClaude
} from '../runtime/types'
import type { SetupCommandRunner } from '../setup/setupCommand'
import { currentState, pausedByUser } from '../state/currentState'
import { lineupStrip } from '../state/lineupStrip'
import type { Repos } from '../store'
import type { DecisionAction } from '../store/decisions'
import type { AgentRunRow } from '../store/runs'
import { previousAttempt, replaceSummaryPrompt, skippedDigest, skipSummaryPrompt } from './digest'
import { STUCK, STUCK_RULE_TEXT } from '../stuck/config'
import type { StuckNote } from '../stuck/detector'
import type { RunObservation } from '../stuck/observation'
import { isUsageLimitText, limitFromEvent, type UsageLimit } from './usageLimit'

/** What the runner needs of the app-wide usage limit (see UsageGate). */
export interface UsageHooks {
  /** True while the usage limit holds every agent. */
  limited(): boolean
  /** True while no new agent may start: limited, or close to the limit. */
  blocksStarts(): boolean
  /** Why an agent the limit paused is paused: "Usage limit; resumes at 14:00". */
  pauseReason(): string
  /** A `rate_limit` event from an agent (a rejected one enters the limited state). */
  rateLimit(event: Extract<AgentEvent, { kind: 'rate_limit' }>, runId: string): void
  /** An agent ran into the limit without a `rate_limit` event (its error text said so). */
  hit(limit: UsageLimit, runId: string): void
  /** An agent that was let through while limited got an answer: the limit is over. */
  gotThrough(): void
  /** The number of paused agents changed. */
  changed(): void
}

/** How long a role's start waits for the list of changed files; never fetches, and a failure or slow git is no reason not to start. */
const CHANGED_FILES_TIMEOUT_MS = 3000

export interface RunnerDeps {
  repos: Repos
  worktrees: WorktreeManager
  runtime: AgentRuntime
  now: () => Date
  emit: (e: EngineEvent) => void
  /**
   * True while unattended mode is on for this workspace: permission requests that aren't hard stops are allowed without a card.
   */
  unattended?: (workspaceId: string) => boolean
  /** The app-wide usage limit; without it nothing is limited and a limit just fails the turn. */
  usage?: UsageHooks
  /**
   * Pushes a handed-off ticket's branch and opens its pull request, when the workspace asks for that.
   * Mainbus runs it itself, after the handoff: it never goes through the agent's permissions.
   */
  pullRequests?: { publish(input: PublishInput): Promise<PublishResult> }
  /** Called after a ticket reached Done (`wasDone`: it already was there): what waited on it being open can move on. */
  onMovedToDone?: (ticketId: string, wasDone: boolean) => Promise<void>
  /** Called after a ticket's last role handed off and its push was tried: the branch may now differ from the newest base. */
  branchMoved?: (workspaceId: string) => void
  /**
   * Writes an Investigate ticket's report into its worktree and commits it on its branch, when the workspace asks for
   * that. Mainbus runs it itself, after submit_report; the agent stays read-only. Without it no report is saved as a file.
   */
  reportFiles?: { save(input: SaveReportInput): Promise<SaveReportResult> }
  /** How long a skipped role's summary call may take before the digest is used instead (tests shorten it). */
  summaryTimeoutMs?: number
  /**
   * Ends what an agent leaves running: when its `claude` process exits, and before a worktree is removed.
   * Without it nothing is swept.
   */
  processes?: ProcessSweeper
  /** Called after a run ended as failed (and its error was recorded); the orchestrator hears of it in a turn of its own. */
  onFailed?: (failed: { workspaceId: string; ticketId: string; runId: string }) => void | Promise<void>
  /**
   * Copies the ticket's attachments into `<scratch>\attachments` and returns the copies, for the role's prompt.
   * Without it a role is told of none.
   */
  attachments?: { sync(ticketId: string, scratch: string): Promise<PromptAttachment[]> }
  /** The ref a ticket's changes are listed against in a role's prompt. Without it, the workspace's base branch. */
  baseRef?: (ws: Workspace) => Promise<string>
  /**
   * Runs the workspace's setup command in a new ticket folder, before its first role starts. Mainbus runs it itself,
   * never through an agent or the permission guard. Without it no setup runs.
   */
  setup?: SetupCommandRunner
  /** What Mainbus knows about the workspace's base-branch tests, for the role's prompt; null for none. Without it a role is told nothing. */
  baseTests?: (workspaceId: string) => Promise<BaseTestsSummary | null>
}

export const NUDGE_TEXT =
  'You ended your turn without asking the user or handing off. If you are done, commit and call mcp__mainbus__handoff. If you need the user, call mcp__mainbus__ask_user. Otherwise continue.'
/** The nudge for an Investigate role: it never commits, and the last one ends with a report. */
const INVESTIGATE_NUDGE_TEXT =
  'You ended your turn without asking the user or handing off. If you are done, call mcp__mainbus__handoff. If you need the user, call mcp__mainbus__ask_user. Otherwise continue.'
const REPORT_NUDGE_TEXT =
  'You ended your turn without asking the user or submitting your report. If you are done, call mcp__mainbus__submit_report with your report. If you need the user, call mcp__mainbus__ask_user. Otherwise continue.'

function nudgeText(kind: TicketKind, endsWithReport: boolean): string {
  if (endsWithReport) return REPORT_NUDGE_TEXT
  return kind === 'investigate' ? INVESTIGATE_NUDGE_TEXT : NUDGE_TEXT
}
const CONTINUE_TEXT = 'Continue where you left off.'
/** What an agent that was working when Mainbus closed is told when it comes back. */
export const RESTART_TEXT = 'Mainbus restarted; continue where you left off.'
const SETUP_FAILED_OPEN = 'The setup command failed: answer the decision about it first (Retry, Start without setup or Stop)'
const FOLDER_MISSING = "This ticket's folder is missing: answer the decision about it first"
/** What Resume sends to a role the user paused. */
const RESUME_TEXT = 'Continue.'
/** How long the summary call for a skipped role may take before the digest is used instead. */
export const SKIP_SUMMARY_MS = 120_000
const NOTHING_PAUSED = 'There is no paused agent to resume on this ticket'
const PAUSED_BY_USER = 'You paused this agent: use Resume to continue it'
const STILL_STOPPING = 'The agent is still stopping; try again in a moment'
const ASK_RECORDED = 'Recorded. End your turn now; the answer will arrive as your next message.'
const HANDED_OFF = 'Handed off. Your part is done; end your turn now.'
const COMMIT_FIRST =
  'Not handed off: the worktree has uncommitted changes. Commit all your work on the current branch, then call mcp__mainbus__handoff again.'
const REPORT_SUBMITTED = 'Report submitted. Your part is done; end your turn now.'
const MUST_SUBMIT_REPORT =
  'Not handed off: an Investigate ticket ends with a report. Call mcp__mainbus__submit_report with your report in markdown.'
const NOT_INVESTIGATE =
  'Not submitted: submit_report is only for Investigate tickets. When your part is finished, call mcp__mainbus__handoff.'
const NOT_LAST_ROLE =
  'Not submitted: only the last role of an Investigate lineup submits a report. When your part is finished, call mcp__mainbus__handoff.'
const EMPTY_REPORT = 'Not submitted: the report is empty. Write up what you found and call mcp__mainbus__submit_report again.'
const REPORT_NOT_SAVED = "The report isn't saved in the repo yet, so there is nothing to push: save it to the repo first"
const REPORT_SAVE_FAILED = "Couldn't save the report to the repo"
const REPORTS_OFF = 'Turn on "Save investigation reports in the repo" in the workspace settings first'
const NO_REPORT = 'This ticket has no report to save'
const REPORT_NOT_IN_REVIEW = 'Only an Investigate ticket in Review can save its report to the repo'
const REPORT_NO_BRANCH = 'This ticket has no branch to save its report on'
const RUN_ENDED = 'This run has ended.'
const REDIRECT_STALE = 'The agent is no longer stuck in that episode, or it was already redirected'
const NOT_WORKING = 'No agent is working on this ticket'
export const MOVED_ON = 'The ticket has moved on: that role is no longer the active one'

/** What the user chose for the run that replaces another. */
export interface ReplaceRequest {
  model: string
  effort: Effort
  /** Added to the ticket run's own instructions for the new run only; null for none. */
  extraInstructions: string | null
  /** The proposal that was confirmed, for the timeline to link to. */
  proposalId?: string
  /** Who proposed it. */
  suggestedBy?: 'orchestrator' | 'user'
}

/** The run an action was meant for; the action fails rather than act on another role. */
export interface RunExpectation {
  agentRunId: string
}
const LEFTOVER_OPTIONS = ['Delete the folder and move to Done', 'Keep it']

const LEFTOVER_LISTED = 10

/** The question about a ticket folder that git no longer lists: what is in it and whether its commits are safe. */
function leftoverQuestion(folder: string, branch: string, found: LeftoverFolder): string {
  const count = (n: number) => `${n.toLocaleString('en-US')} file${n === 1 ? '' : 's'}`
  const top = found.entries[0]
  const mostly = top && found.files > 0 && top.files * 2 > found.files ? `, mostly in ${top.name}` : ''
  const listed = found.entries.slice(0, LEFTOVER_LISTED).map((e) => `${e.name} (${count(e.files)})`)
  const more = found.entries.length - LEFTOVER_LISTED
  const commits =
    found.commits === 'kept'
      ? `Its commits are kept: they are on the branch ${branch}, which still exists.`
      : `Mainbus can't tell whether its commits are kept: the branch ${branch} no longer exists.`
  return [
    `This ticket's folder is no longer a git worktree (a removal was interrupted) and still holds ${count(found.files)}${mostly}.`,
    folder,
    `It holds: ${listed.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`,
    commits
  ].join('\n')
}

const ENDED_RUN_MOVE = 'Start again or move to Done'
const SILENT_FAILURE = 'Ended two turns in a row without asking the user or handing off'
const PERMISSION_OPTIONS = ['Allow once', 'Always allow in this workspace', 'Deny']
/** How long stop() waits for the agent's remaining events after the process is told to stop. */
const STOP_DRAIN_MS = 2000
/** How long shutdown waits for launches and queued user actions to finish before it drains the live agents. */
const SHUTDOWN_SETTLE_MS = 5000
/** How long shutdown waits for the sweeps of exited agents. */
const SWEEP_WAIT_MS = 15_000
const SHUTTING_DOWN = 'Mainbus is shutting down'
/** What a run the usage limit paused starts with when it resumes. */
export const USAGE_RESUME_TEXT = 'The usage limit has reset; continue where you left off.'
const PAUSED_BY_LIMIT = 'Paused by the usage limit: use Resume to continue it now'
const USAGE_PAUSED_FALLBACK = USAGE_PAUSED_PREFIX + ' resuming'
const AUTO_ALLOWED = 'Allowed by unattended mode'
const PR_FAILED = "Couldn't open a PR"
const PR_SETTING_OFF = 'Turn on "Open a PR when a ticket reaches Review" in the workspace settings first'
const PR_NOT_IN_REVIEW = 'Only a ticket in Review can be pushed'
const PR_NO_BRANCH = 'This ticket has no branch to push'
const NO_ROLES = 'Tick at least one role to start'
const KEEP_GOING = 'Keep going'
const TAKE_OVER = 'Take over'
/** Hand-backs between the same two roles before the user is asked whether to keep going. */
const ROUND_TRIP_CAP = 3

/** Where a thread event goes: the run's thread, announced for its ticket and workspace. */
interface ThreadTarget {
  runId: string
  /** The ticket run the run belongs to. */
  ticketRunId: string
  ticketId: string
  workspaceId: string
  /** The name of the run's role. */
  role: string
}

/** A run whose agent process is alive. Exists from `start` until its events have ended and been wrapped up. */
interface LiveRun extends ThreadTarget {
  handle: RunHandle
  /** What a silent turn is nudged with. */
  nudge: string
  /** Turns ended in a row without ask_user, handoff or a pending decision. */
  silentTurns: number
  /** Turns ended in a row with an error. */
  errorTurns: number
  /** ask_user was called since the last turn_end. */
  askedThisTurn: boolean
  /** Set once the run is ended or being stopped; its process gets no more nudges or messages. */
  ended: boolean
  /** Set by the first stop request; the handle must not be used after it. */
  stopping: Promise<void> | null
  /** The usage limit the agent last ran into, until a request is allowed again or a turn succeeds. */
  limit: UsageLimit | null
  /** When the process was launched, and when it last did or was given anything (ms since the epoch): for the stuck detector. */
  startedAt: number
  lastActivityAt: number
  /** When the turn under way began (a launch, message, answer or nudge), and whether it has not ended yet. */
  turnStartedAt: number
  inTurn: boolean
  /** Settles when the event pump has finished. */
  done: Promise<void>
}

/** A launch that already has its slot: the queue's turn came, or a failed resume starts afresh. */
interface QueuedStart {
  granted: true
}

/** A ticket with its worktree ready. */
interface Prepared {
  ticket: Ticket
  workspace: Workspace
  /** `scratch` is the ticket's scratch folder: its agents' temp folder, writable like the worktree. */
  worktree: { branch: string; path: string; scratch: string; baseNotice: string | null }
  /** The files the branch changes against its base, for the role's prompt; null when unknown or not looked up. */
  changes: BranchChanges | null
}

/** What `updateFromMain` runs: the role to run alone, its extra instructions, what the thread says, and whether the setup command is due again. */
export interface UpdateFromMainInput {
  roleId: string
  extraInstructions: string
  notice: string
  setupAgain: boolean
  /** The model and effort the ticket's saved run settings give the role, if any. */
  roles?: Record<string, { model?: string; effort?: Effort }>
}

interface Launch extends Prepared {
  role: LineupRole
  /** The ticket run the launched run belongs to. */
  ticketRunId: string
  /** What the earlier roles of the run's ticket run said when they handed off. */
  handoffs: EarlierHandoff[]
  /** The ticket run's extra instructions, for every role in it, or null. */
  extraInstructions: string | null
}

type PermissionWaiter = (a: DecisionAnswer | null) => void

/**
 * Drives a ticket through its lineup, one role's agent at a time: starts and resumes each, records its thread,
 * turns its asks into decisions, and starts the next role when one hands off. User actions on a ticket run
 * one at a time, in order; agent callbacks are not queued, and every run ending goes through the conditional
 * `runs.end` or `runs.handOn`, so the first ending wins.
 */
export class TicketRunner {
  private readonly repos: Repos
  private readonly live = new Map<string, LiveRun>()
  /** The tail of each ticket's queue of user actions. */
  private readonly chains = new Map<string, Promise<void>>()
  /** Tickets being launched right now (worktree setup and process start). */
  private readonly launching = new Set<string>()
  /** Tickets whose role just handed off to the next, until the next role's launch has run its course. */
  private readonly handingOn = new Set<string>()
  /** Tickets with a stop on the way: launches skip or immediately stop their process. */
  private readonly stopRequested = new Set<string>()
  /** Set by shutdown(): nothing new launches, and a process that finishes starting is stopped at once. */
  private shuttingDown = false
  /** True from the start of restart recovery until just before its last board refresh. */
  private recovering = false
  /** Permission decisions an agent is waiting on, by decision id. */
  private readonly waiters = new Map<string, PermissionWaiter>()
  /** Runs allowed past the usage-limit gate: the probe, and a run the user resumed early. Cleared when the limit ends. */
  private readonly limitBypass = new Set<string>()
  /** The marking of the agents the latest usage-limit pause stopped; their processes' wrap-up waits for it. */
  private limitMarking: Promise<unknown> = Promise.resolve()
  /** The `claude` process of each run launched in this session, once its start time is known (null: unknown). */
  private readonly processRefs = new Map<string, Promise<ProcessRef | null>>()
  /** The sweeps under way or queued, by run: a run is never swept twice at once. */
  private readonly sweeps = new Map<string, Promise<void>>()
  /** Tickets that were given a slot and are launching their agent: from the grant until the process is up or the launch has failed. */
  private readonly admitting = new Set<string>()
  /** Tickets whose role handed off (or was skipped or replaced) while it held a slot: their next launch takes that slot. */
  private readonly slotKept = new Set<string>()
  /** Tickets whose setup command is running right now. */
  private readonly settingUp = new Set<string>()
  /** The setup command running for each ticket in `settingUp`: abort it to end it; `done` settles once it has ended. */
  private readonly setups = new Map<string, { controller: AbortController; done: Promise<void> }>()
  /** Serializes the decisions about slots, so two starts never take the last one together. */
  private slotLock: Promise<unknown> = Promise.resolve()
  /** There may be runs in the queue (true until a look at it finds none); lets the common case skip the database. */
  private queueHint = true
  private draining: Promise<void> | null = null
  private drainAgain = false

  /**
   * True while any agent is at work in any workspace: one is starting, being set up, or handing on, or a live one is in
   * the middle of a turn. An agent waiting for the user or for a slot is not working, so it doesn't hold anything back forever.
   */
  agentsWorking(): boolean {
    if (this.launching.size > 0 || this.handingOn.size > 0 || this.settingUp.size > 0) return true
    for (const run of this.live.values()) if (!run.ended && run.stopping === null && run.inTurn) return true
    return false
  }

  constructor(private readonly deps: RunnerDeps) {
    this.repos = deps.repos
  }

  /**
   * True while the ticket is being launched (worktree setup and process start), before or after its run exists,
   * and from one role handing off until the next role's launch is over.
   */
  isLaunching(ticketId: string): boolean {
    return this.launching.has(ticketId) || this.handingOn.has(ticketId) || this.settingUp.has(ticketId)
  }

  private unattended(workspaceId: string): boolean {
    return this.deps.unattended?.(workspaceId) ?? false
  }

  /** Tells every open workspace's board to refresh. */
  private async emitBoardChangedEverywhere(): Promise<void> {
    for (const workspace of await this.repos.workspaces.list()) {
      this.deps.emit({ type: 'board.changed', workspaceId: workspace.id })
    }
  }

  /**
   * Starts queued agents, first in first out, while slots are free. Called whenever a slot may have freed up: an agent
   * ended, paused or deferred, the cap rose, or the app started with a queue left over. Several calls at once make one pass.
   */
  kickQueue(): void {
    if (this.shuttingDown || !this.queueHint) return
    if (this.draining) {
      this.drainAgain = true
      return
    }
    this.draining = this.drain()
      .catch(() => {})
      .finally(() => {
        this.draining = null
        if (this.drainAgain) {
          this.drainAgain = false
          this.kickQueue()
        }
      })
  }

  /** Settles when the queue has been looked at and everything that could start has been started (for tests). */
  async queueSettled(): Promise<void> {
    while (this.draining) await this.draining
  }

  /** The place in the queue (1 first) of the ticket's open run, or null when it isn't queued. */
  private async queuePositionOf(run: AgentRunRow | null): Promise<number | null> {
    if (!run || run.endReason !== null || run.queuedSeq === null) return null
    const i = (await this.repos.runs.queued()).findIndex((q) => q.id === run.id)
    return i < 0 ? null : i + 1
  }

  /** Runs `fn` after the slot decisions made before it. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.slotLock.then(fn)
    this.slotLock = result.catch(() => {})
    return result
  }

  /**
   * True when the ticket's agent uses a slot: a launch the ticket was granted, a slot a handoff passed on, or an agent
   * alive and not paused, not stopped by a usage limit and not waiting only on a deferred decision. One waiting on a
   * pending decision still uses it. The orchestrator is not a ticket's agent and never comes here.
   */
  private async holdsSlot(ticketId: string): Promise<boolean> {
    if (this.admitting.has(ticketId) || this.slotKept.has(ticketId)) return true
    const alive = [...this.live.values()].some((l) => l.ticketId === ticketId && !l.ended && !l.stopping)
    if (!alive) return false
    if ((await this.repos.decisions.pending(ticketId)).length > 0) return true
    return (await this.repos.decisions.deferred(ticketId)).length === 0
  }

  /** How many slots are in use by tickets other than `except`. */
  private async slotsInUse(except?: string): Promise<number> {
    const tickets = new Set<string>([...this.admitting, ...this.slotKept])
    for (const live of this.live.values()) tickets.add(live.ticketId)
    if (except !== undefined) tickets.delete(except)
    let used = 0
    for (const id of tickets) if (await this.holdsSlot(id)) used++
    return used
  }

  /**
   * Decides whether the run may launch now. It may when a slot is free and nobody is waiting ahead of it, or when a
   * handoff passed its ticket's slot on. Otherwise it joins the back of the queue (a run already in it keeps its
   * place, and `prompt` is added to its message) and false comes back.
   */
  private admit(ticketId: string, runId: string, prompt: string): Promise<boolean> {
    return this.locked(async () => {
      const bypass = this.limitBypass.has(runId)
      // Near or at the usage limit nothing new starts (but the probe and a run resumed early): it waits as Queued.
      if (this.deps.usage?.blocksStarts() && !bypass) {
        this.slotKept.delete(ticketId)
        await this.enqueueRun(ticketId, runId, prompt)
        this.queueHint = true
        return false
      }
      if (this.slotKept.delete(ticketId)) {
        this.admitting.add(ticketId)
        return true
      }
      const waiting = (await this.repos.runs.queued()).some((q) => q.id !== runId)
      const free = (await this.repos.settings.get()).maxAgents - (await this.slotsInUse(ticketId))
      if (free > 0 && (bypass || !waiting) && !(await this.repos.runs.get(runId))?.queuedSeq) {
        this.admitting.add(ticketId)
        return true
      }
      await this.enqueueRun(ticketId, runId, prompt)
      this.queueHint = true
      return false
    })
  }

  /** Queues the run, and records the moment it joined the queue (not when it was queued already: that only adds to its message). */
  private async enqueueRun(ticketId: string, runId: string, prompt: string): Promise<void> {
    const before = await this.repos.runs.get(runId)
    await this.repos.runs.enqueue(runId, prompt)
    if (before && before.queuedSeq === null && before.endReason === null) await this.recordQueued(ticketId, before)
  }

  private async recordQueued(ticketId: string, run: AgentRunRow): Promise<void> {
    const ticket = await this.repos.tickets.get(ticketId)
    if (ticket) await this.record(this.target(run, ticket), { kind: 'queued' }).catch(() => {})
  }

  /** Starts the queue's runs, oldest first, until the slots are full. */
  private async drain(): Promise<void> {
    for (;;) {
      const head = await this.locked(async () => {
        if (this.shuttingDown) return null
        const queue = await this.repos.runs.queued()
        if (queue.length === 0) {
          this.queueHint = false
          return null
        }
        // Blocked by the usage limit, only a run let past the gate starts.
        const first = this.deps.usage?.blocksStarts() ? queue.find((q) => this.limitBypass.has(q.id)) : queue[0]
        if (!first) return null
        const free = (await this.repos.settings.get()).maxAgents - (await this.slotsInUse(first.ticketId))
        if (free <= 0) return null
        this.admitting.add(first.ticketId)
        return first
      })
      if (head === null) return
      await this.startQueued(head)
    }
  }

  /** Launches a run that has been given a slot, as the next step of its ticket's queue of actions. */
  private async startQueued(queued: AgentRunRow): Promise<void> {
    try {
      await this.serial(queued.ticketId, async () => {
        const run = await this.repos.runs.latest(queued.ticketId)
        // Stopped (or moved on) while it waited: nothing to start.
        if (!run || run.id !== queued.id || run.endReason !== null || run.queuedSeq === null) return
        await this.repos.runs.dequeue(run.id)
        await this.resume(run, run.queuedPrompt ?? CONTINUE_TEXT, undefined, { granted: true })
      })
    } catch (err) {
      // The launch records its own failures; this is for the ones it never got to (the worktree, say).
      const ticket = await this.repos.tickets.get(queued.ticketId).catch(() => null)
      const last = (await this.repos.runs.events(queued.id).catch(() => [])).at(-1)?.event
      if (ticket && !(last?.kind === 'error' && last.message === errorText(err))) {
        await this.record(this.target(queued, ticket), { kind: 'error', message: errorText(err) }).catch(() => {})
      }
    } finally {
      this.admitting.delete(queued.ticketId)
    }
  }

  /** Runs the ticket through its lineup as a new ticket run: the roles in `opts.roleIds`, or all of them. */
  start(ticketId: string, opts: StartOptions = {}): Promise<void> {
    return this.serial(ticketId, () => this.startNow(ticketId, opts))
  }

  send(ticketId: string, text: string): Promise<void> {
    return this.serial(ticketId, () => this.sendNow(ticketId, text))
  }

  /**
   * Tells the ticket's live agent of something the user did outside the thread, such as attaching an image: a short
   * Mainbus message, also shown in its thread. It takes the ticket's queue and the agent's input like the user's own
   * messages, so it never interrupts a turn. Without a live agent nothing is sent: the next launch's prompt has it.
   */
  announce(ticketId: string, text: string): Promise<void> {
    return this.serial(ticketId, async () => {
      if (this.shuttingDown || this.stopRequested.has(ticketId)) return
      const run = await this.repos.runs.latest(ticketId)
      const live = run && run.endReason === null ? this.live.get(run.id) : undefined
      if (!live || live.ended || live.stopping) return
      live.silentTurns = 0
      await this.record(live, { kind: 'notice', text })
      await this.deliver(live, text)
    })
  }

  /** The one path every answer takes, whichever place (`via`) the user answered from. */
  async answer(decisionId: string, a: DecisionAnswer, via: CardVia): Promise<void> {
    if (!ANSWERED_VIA.includes(via)) throw new Error('An answer must say where it came from: the board, the orchestrator or the thread')
    const { ticketId } = await this.repos.decisions.get(decisionId)
    return this.serial(ticketId, () => this.answerNow(decisionId, a, via))
  }

  /** Records what one of Mainbus's own calls for the ticket used (the promote draft) on its latest run, which has events. */
  async recordCallUsage(ticketId: string, usage: UsageEvent): Promise<void> {
    const run = await this.repos.runs.latest(ticketId)
    if (!run) return
    await this.record(this.target(run, await this.repos.tickets.get(ticketId)), usage)
  }

  /** Takes effect on an in-flight launch as soon as its process starts; the rest waits its turn. */
  async stop(ticketId: string, expect?: RunExpectation): Promise<void> {
    // A stop for a run that has moved on must not mark the ticket as stopping, or it would kill the next role's launch.
    if (expect) await this.assertExpected(ticketId, expect)
    this.stopRequested.add(ticketId)
    // The stop itself waits behind the action that is running setup, so setup is ended here, at once.
    this.setups.get(ticketId)?.controller.abort()
    return this.serial(ticketId, () => this.stopNow(ticketId, expect))
  }

  /** The ticket's open run's active role and the one a skip would start; null with no run or an ended one. */
  async activeRole(ticketId: string): Promise<{
    agentRunId: string
    role: string
    agentStatus: TicketState['agentStatus']
    model: string
    effort: Effort
    next: string | null
  } | null> {
    const { state, run, roles } = await this.inspect(ticketId, false)
    if (!run || run.endReason !== null) return null
    // Ticket runs started before models were resolved at start hold nulls: those get the default table.
    const role = roles ? launchRole(roles, run) : null
    const fallback = defaultFor(run.role)
    return {
      agentRunId: run.id,
      role: run.role,
      agentStatus: state.agentStatus,
      model: role?.model ?? fallback.model,
      effort: role?.effort ?? fallback.effort,
      next: (await this.nextRole(run))?.name ?? null
    }
  }

  /**
   * What the stuck detector needs to know about the ticket's open run; null when the ticket has none. Read
   * outside the ticket's queue: it changes nothing.
   */
  async observeRun(ticketId: string): Promise<RunObservation | null> {
    const { state, run } = await this.inspect(ticketId, false)
    if (!run || run.endReason !== null) return null
    const ticket = await this.repos.tickets.get(ticketId)
    const events = await this.repos.runs.events(run.id)
    const live = this.live.get(run.id)
    return {
      runId: run.id,
      ticketId,
      workspaceId: ticket.workspaceId,
      role: run.role,
      worktreePath: ticket.worktreePath,
      state,
      launching: this.isLaunching(ticketId),
      usageLimited: run.limitPausedSeq !== null || (this.deps.usage?.limited() ?? false) || (live?.limit ?? null) !== null || endedOnUsageLimit(events),
      declaredWait: run.declaredWait,
      events,
      live: live
        ? { lastActivityAt: live.lastActivityAt, startedAt: live.startedAt, turnStartedAt: live.turnStartedAt, inTurn: live.inTurn }
        : null
    }
  }

  private async assertExpected(ticketId: string, expect: RunExpectation): Promise<void> {
    const latest = await this.repos.runs.latest(ticketId)
    if (!latest || latest.id !== expect.agentRunId || latest.endReason !== null) throw new Error(MOVED_ON)
  }

  continue(ticketId: string): Promise<void> {
    return this.serial(ticketId, () => this.continueNow(ticketId))
  }

  /** The user's Pause: interrupts the active role and stops its process; the run stays open until Resume. */
  pause(ticketId: string, expect?: RunExpectation): Promise<void> {
    return this.serial(ticketId, () => this.pauseNow(ticketId, expect))
  }

  /**
   * The user's confirmed redirect: interrupts the role's current turn, keeping its process and session, and sends
   * `message` as its next message. `claim` is asked once everything else checks out, and says whether the
   * redirect is still allowed (it records it); a false answer fails, with nothing interrupted.
   */
  redirect(ticketId: string, expect: RunExpectation, message: string, claim: () => Promise<boolean>, proposalId?: string): Promise<void> {
    return this.serial(ticketId, () => this.redirectNow(ticketId, expect, message, claim, proposalId))
  }

  /** Called by the stuck detector: puts the episode's news in the thread of the ticket's open run, if `runId` is still it. */
  async noteStuck(ticketId: string, runId: string, note: StuckNote): Promise<void> {
    const run = await this.repos.runs.latest(ticketId)
    if (!run || run.id !== runId || run.endReason !== null) return
    const ticket = await this.repos.tickets.get(ticketId)
    const { episode } = note
    await this.record(this.target(run, ticket), {
      kind: 'stuck',
      role: run.role,
      change: note.change,
      episodeId: episode.id,
      rule: episode.rule,
      evidence: episode.evidence,
      ...(note.count === undefined ? {} : { count: note.count })
    })
  }

  /**
   * The user's confirmed replacement of the active role's agent: its process ends, its run ends as replaced with a
   * handoff summary Mainbus generates from its log (or the digest, if that fails), and a fresh agent of the same
   * role starts in the same worktree and ticket run, with that summary. Other roles' runs and the ticket run's
   * snapshot are untouched.
   */
  replace(ticketId: string, expect: RunExpectation, request: ReplaceRequest): Promise<void> {
    return this.serial(ticketId, () => this.replaceNow(ticketId, expect, request))
  }

  /**
   * Called by the stuck detector when an episode opens on the run: a role whose agent was already replaced
   * STUCK.maxReplacements times in this ticket run is marked Failed, with a plain account of what was tried, instead
   * of being offered another redirect or replacement. False when the run isn't in that position.
   */
  async failIfExhausted(ticketId: string, runId: string): Promise<boolean> {
    const run = await this.repos.runs.latest(ticketId)
    if (!run || run.id !== runId || run.endReason !== null) return false
    if ((await this.repos.runs.replacedCount(run.ticketRunId, run.roleId)) < STUCK.maxReplacements) return false
    const account = await this.stuckAccount(run)
    if (!(await this.repos.runs.end(run.id, 'failed'))) return false
    const ticket = await this.repos.tickets.get(ticketId)
    const live = this.live.get(run.id)
    if (live) live.ended = true
    await this.record(this.target(run, ticket), { kind: 'stuck_failed', role: run.role, replacements: STUCK.maxReplacements })
    await this.record(this.target(run, ticket), { kind: 'error', message: account })
    if (live) void this.stopProcess(live)
    this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
    this.kickQueue()
    await this.deps.onFailed?.({ workspaceId: ticket.workspaceId, ticketId, runId: run.id })
    return true
  }

  /** The user's Resume of a role they paused: the same session, with "Continue.". Never resumes any other pause. */
  resumePaused(ticketId: string): Promise<void> {
    return this.serial(ticketId, () => this.resumeNow(ticketId))
  }

  /**
   * The user's Skip to next role: ends the active role as handed off, with a summary of its log that Mainbus
   * generates (or a digest, if that fails), and starts the next ticked role. Skipping the last role puts the
   * ticket in Review, and the push and PR follow as after a handoff.
   */
  skip(ticketId: string, expect?: RunExpectation): Promise<void> {
    return this.serial(ticketId, () => this.skipNow(ticketId, expect))
  }

  /**
   * Pushes the ticket's branch and opens its pull request again, after a failure. The user's Retry only:
   * the agent intake has no way to it. It never forces the push.
   */
  openPr(ticketId: string): Promise<void> {
    return this.serial(ticketId, () => this.publishNow(ticketId, true))
  }

  /**
   * "Save report to repo": writes and commits an Investigate ticket's report again, after a failure, then pushes and
   * opens its PR when the workspace asks for that. The user's retry only: the agent intake has no way to it.
   */
  saveReport(ticketId: string): Promise<void> {
    return this.serial(ticketId, () => this.saveReportNow(ticketId, true))
  }

  /** Records in the ticket's Activity that the user merged its branch (Merge…); in the latest run's thread, like its pull request. */
  recordMerged(ticketId: string, event: Extract<ThreadEvent, { kind: 'merged' }>): Promise<void> {
    return this.serial(ticketId, async () => {
      const run = await this.repos.runs.latest(ticketId)
      if (!run) return
      await this.record(this.target(run, await this.repos.tickets.get(ticketId)), event)
    })
  }

  moveToDone(ticketId: string): Promise<'done' | 'dirty' | 'asked'> {
    return this.serial(ticketId, () => this.moveToDoneNow(ticketId))
  }

  /** Moves a ticket to Backlog or Ready in its turn, so it can't slip in between `start` and the run it creates. */
  moveToColumn(ticketId: string, column: 'backlog' | 'ready'): Promise<void> {
    return this.serial(ticketId, () => this.moveToColumnNow(ticketId, column))
  }

  /** The ticket's state, from its latest agent run: mid-lineup, the active role's. */
  async stateOf(ticketId: string): Promise<TicketState> {
    return (await this.inspect(ticketId, false)).state
  }

  /**
   * The ticket's state and its lineup strip, as the board shows them. Before the first run the strip is the
   * workspace lineup, which `workspaceLineup` reads (the board reads it once for all its tickets).
   */
  async boardView(
    ticketId: string,
    workspaceLineup: () => Promise<LineupRole[]>
  ): Promise<{ state: TicketState; lineup: StripRole[]; skipTo: string | null; pendingDecisions: Decision[]; deferredDecisions: Decision[] }> {
    const { state, run, roles, pending, deferred } = await this.inspect(ticketId, true)
    if (!run || !roles) {
      const lineup = lineupStrip({ roles: await workspaceLineup(), runs: [], latestRunId: null, agentStatus: null })
      return { state, lineup, skipTo: null, pendingDecisions: pending, deferredDecisions: deferred }
    }
    const runs = await this.repos.runs.listForTicketRun(run.ticketRunId)
    // The role Skip would start, named in its confirmation.
    const skipTo = run.endReason === null && state.column !== 'done' ? ((await this.nextRole(run))?.name ?? null) : null
    const lineup = lineupStrip({ roles, runs, latestRunId: run.id, agentStatus: state.agentStatus, queuePosition: state.queuePosition })
    return { state, lineup, skipTo, pendingDecisions: pending, deferredDecisions: deferred }
  }

  /**
   * The ticket's state, its latest run and that run's ticket-run roles (null with no run). For a Done ticket
   * the run is loaded only when `doneRun` asks for it: Done wins over everything else in its state.
   */
  private async inspect(
    ticketId: string,
    doneRun: boolean
  ): Promise<{ state: TicketState; run: AgentRunRow | null; roles: LineupRole[] | null; pending: Decision[]; deferred: Decision[] }> {
    const ticket = await this.repos.tickets.get(ticketId)
    const done = ticket.manualColumn === 'done'
    const run = !done || doneRun ? await this.repos.runs.latest(ticketId) : null
    const roles = run ? (await this.repos.runs.ticketRun(run.ticketRunId)).roles : null
    if (done) {
      // The run's events and the decisions need not be loaded.
      const state = currentState({ ticket, run: null, pendingDecisions: [], processAlive: false, activePhase: 'done' })
      return { state, run, roles, pending: [], deferred: [] }
    }
    const pending = (await this.repos.decisions.pending(ticketId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const deferred = (await this.repos.decisions.deferred(ticketId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const activePhase: Phase = run && roles ? roleIn(roles, run).activePhase : 'not_started'
    const state = currentState({
      ticket,
      run: run ? { endReason: run.endReason, events: await this.repos.runs.events(run.id) } : null,
      pendingDecisions: pending,
      deferredDecisions: deferred,
      processAlive: run ? this.live.has(run.id) || this.isLaunching(ticketId) : false,
      settingUp: this.settingUp.has(ticketId),
      queuePosition: await this.queuePositionOf(run),
      limitPaused: run && run.limitPausedSeq !== null ? { reason: this.deps.usage?.pauseReason() || USAGE_PAUSED_FALLBACK } : null,
      activePhase
    })
    return { state, run, roles, pending, deferred }
  }

  /**
   * Called once at launch, before anything starts: no agent process survives a restart in M1.
   * Pending permission decisions can never reach their agent, so they expire; questions stay
   * pending and are delivered when the session is resumed.
   */
  async markAllNotAlive(): Promise<void> {
    for (const workspace of await this.repos.workspaces.list()) {
      for (const ticket of await this.repos.tickets.list(workspace.id)) {
        await this.expirePending({ ticketId: ticket.id, workspaceId: workspace.id }, (d) => d.kind === 'permission')
      }
      this.deps.emit({ type: 'board.changed', workspaceId: workspace.id })
    }
  }

  /**
   * Called at launch, once the board can show: brings the agents that were working back, and leaves every other run as it
   * was. Processes a crash left behind are swept first, so no old agent runs beside its resumed self. A working run (open,
   * not paused by the user, not waiting on a decision, not stopped by a usage limit) is resumed by its session through the
   * queue, ahead of runs that were already queued, oldest first. A run whose folder is missing is never restarted: it
   * becomes a decision. With `resume` false (no runtime) only the sweeps and decisions happen.
   */
  async recover(opts: { resume: boolean }): Promise<void> {
    this.recovering = true
    try {
      await this.recoverRuns(opts)
    } finally {
      this.recovering = false
    }
  }

  /** True while restart recovery has not finished: agents shown as paused may be about to resume. */
  isRecovering(): boolean {
    return this.recovering
  }

  private async recoverRuns(opts: { resume: boolean }): Promise<void> {
    const unswept = new Set<string>()
    for (const run of await this.repos.runs.withProcess()) {
      if (this.shuttingDown) return
      const ticket = await this.repos.tickets.get(run.ticketId)
      const target = this.target(run, ticket)
      const stored = { pid: run.processPid!, startedAt: run.processStartedAt ?? 0 }
      await this.serial(ticket.id, async () => {
        try {
          await this.sweepRun(target, stored)
        } catch {
          if (run.endReason === null) unswept.add(ticket.id)
          await this.record(target, {
            kind: 'notice',
            text: `Mainbus couldn't check whether the ${run.role}'s old process is still running, so it didn't restart it. Use Continue when you're ready.`
          })
        }
      }).catch(() => {})
    }

    const working: string[] = []
    for (const open of await this.repos.runs.listOpen()) {
      if (this.shuttingDown) return
      await this.serial(open.ticketId, async () => {
        const run = await this.repos.runs.latest(open.ticketId)
        if (!run || run.id !== open.id || run.endReason !== null) return
        const ticket = await this.repos.tickets.get(run.ticketId)
        if (ticket.manualColumn === 'done') return
        if (ticket.worktreePath !== null && !(await pathExists(ticket.worktreePath))) {
          await this.repos.runs.dequeue(run.id)
          await this.askAboutMissingFolder(run, ticket)
          return
        }
        if (run.queuedSeq !== null || run.limitPausedSeq !== null || unswept.has(ticket.id)) return
        const events = await this.repos.runs.events(run.id)
        if (pausedByUser(events) || endedOnUsageLimit(events)) return
        if ((await this.repos.decisions.unsettled(ticket.id)).length > 0) return
        // The app quit while the setup command ran: the run shows as paused, and Continue runs setup again.
        if (ticket.setup?.state === 'pending') return
        working.push(run.id)
      }).catch(() => {})
    }
    if (this.shuttingDown) return
    const unqueued = new Set<string>()
    for (const id of working) if ((await this.repos.runs.get(id))?.queuedSeq === null) unqueued.add(id)
    await this.repos.runs.enqueueFirst(working, RESTART_TEXT)
    for (const id of unqueued) {
      const run = await this.repos.runs.get(id)
      if (run) await this.recordQueued(run.ticketId, run)
    }
    if (working.length > 0) this.queueHint = true
    // The queued runs now show as active on their own, so the refresh below needs no recovery allowance.
    this.recovering = false
    await this.emitBoardChangedEverywhere()
    if (opts.resume) this.kickQueue()
  }

  /** Opens the decision about a run whose folder is gone, unless one is open already. */
  private async askAboutMissingFolder(run: AgentRunRow, ticket: Ticket): Promise<void> {
    if (await this.openFolderDecision(ticket.id, run.id)) return
    const folder = ticket.worktreePath!
    const branch = ticket.branch ?? ''
    await this.ask(
      this.target(run, ticket),
      `The ${run.role}'s folder for this ticket is missing (${folder}). Mainbus won't restart it anywhere else.`,
      [`Recreate the folder from ${branch} and continue`, 'Stop the run'],
      null,
      { kind: 'missing_worktree', path: folder, branch }
    )
  }

  /**
   * Called when the app quits: lets launches and queued user actions finish (bounded), stops every live
   * agent process and lets its last events land. Nothing launches once it has begun, and a process that
   * finishes starting meanwhile is stopped. The runs stay open (not stopped), so they show as paused
   * and can be continued next launch.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    // A setup command in progress ends first: the launch waiting on it would otherwise hold up the quit.
    const setups = [...this.setups.values()]
    for (const s of setups) s.controller.abort()
    await settleWithin(Promise.all(setups.map((s) => s.done)).then(() => {}), SWEEP_WAIT_MS)
    await settleWithin(Promise.all([...this.chains.values()]).then(() => {}), SHUTDOWN_SETTLE_MS)
    const lives = [...this.live.values()]
    await Promise.all(lives.map((live) => this.stopProcess(live)))
    await settleWithin(Promise.all(lives.map((live) => live.done)).then(() => {}), STOP_DRAIN_MS)
    // Each exit has started a sweep of what the agent left running; the app must not quit before they finish.
    await settleWithin(Promise.all([...this.sweeps.values()]).then(() => {}), SWEEP_WAIT_MS)
  }

  // --- user actions, run one at a time per ticket ---

  /** Queues `step` behind the ticket's earlier actions; a failed step does not block later ones. */
  private serial<T>(ticketId: string, step: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(ticketId) ?? Promise.resolve()
    const result = previous.then(step)
    const tail = result.then(
      () => {},
      () => {}
    )
    this.chains.set(ticketId, tail)
    void tail.then(() => {
      if (this.chains.get(ticketId) === tail) this.chains.delete(ticketId)
    })
    return result
  }

  private async startNow(ticketId: string, opts: StartOptions, notices: string[] = []): Promise<void> {
    if (this.shuttingDown) throw new Error(SHUTTING_DOWN)
    if (this.stopRequested.has(ticketId)) return
    const latest = await this.repos.runs.latest(ticketId)
    if (latest && latest.endReason === null) {
      throw new Error('This ticket already has an agent; continue or stop it instead')
    }
    const { workspaceId, kind, runSettings } = await this.repos.tickets.get(ticketId)
    const lineup = await this.repos.lineups.get(workspaceId, kind)
    // A start that chooses nothing itself (Start, Start again, unattended mode) uses the ticket's saved run settings.
    if (opts?.roleIds === undefined && opts?.roles === undefined && opts?.extraInstructions === undefined) {
      opts = applyRunSettings(runSettings, lineup).options
    }
    // Copied into the ticket run, so editing the lineup later never changes this run. Each role's model and
    // effort are resolved now, so every launch of the run uses the same ones.
    const picked = pickRoles(lineup, opts?.roleIds)
    const { roles: chosen, extraInstructions } = checkStartOptions(picked, opts)
    const roles = picked.map((role) => {
      const { model, effort } = resolveModelEffort(role, { user: chosen[role.id] })
      return { ...role, model, effort }
    })
    await this.whileLaunching(ticketId, async () => {
      const prepared = await this.prepare(ticketId)
      if (this.stopRequested.has(ticketId) || this.shuttingDown) return
      let prompt = firstMessage(prepared.ticket)
      let answered: Decision[] = []
      if (latest) {
        // Start again: the new agent learns what the earlier run did and what the user decided.
        const decisions = await this.repos.decisions.forTicket(ticketId)
        const digest = previousAttempt(await this.repos.runs.events(latest.id), decisions, latest.role)
        prompt = `${digest}\n\n${prompt}`
        answered = decisions.filter((d) => d.status === 'answered')
      }
      const runId = await this.repos.runs.create(ticketId, roles, extraInstructions)
      // This step holds the ticket's queue and no agent of it is open, so the latest run is the one just created.
      const created = await this.repos.runs.latest(ticketId)
      if (!created || created.id !== runId) throw new Error(`Run ${runId} is not the ticket's latest`)
      // Told before the role starts: that the branch began from the local base, and whatever the caller of this start wants said.
      for (const text of [prepared.worktree.baseNotice, ...notices]) {
        if (text) await this.record(this.target(created, prepared.ticket), { kind: 'notice', text })
      }
      await this.launch(
        { ...prepared, role: roles[0]!, ticketRunId: created.ticketRunId, handoffs: [], extraInstructions },
        runId,
        prompt,
        answered
      )
    })
  }

  /**
   * "Update from main": ends the ticket's open run, if any (it counts as stopped), then starts an Implementer-only run
   * with `input`'s instructions. One step in the ticket's queue, so nothing else slips in between. With `expect` the
   * open run must be that one; `null` means no run was open when the caller looked.
   */
  updateFromMain(ticketId: string, input: UpdateFromMainInput, expect?: RunExpectation | null): Promise<void> {
    return this.serial(ticketId, () => this.updateFromMainNow(ticketId, input, expect))
  }

  private async updateFromMainNow(ticketId: string, input: UpdateFromMainInput, expect?: RunExpectation | null): Promise<void> {
    if (this.shuttingDown) throw new Error(SHUTTING_DOWN)
    if (this.isLaunching(ticketId)) throw new Error('A role is starting on this ticket; try again in a moment')
    const latest = await this.repos.runs.latest(ticketId)
    const open = latest !== null && latest.endReason === null
    if (expect === null && open) throw new Error(MOVED_ON)
    if (expect && (!open || latest.id !== expect.agentRunId)) throw new Error(MOVED_ON)
    if (open) await this.stopNow(ticketId, expect ?? undefined)
    if (input.setupAgain) {
      const ticket = await this.repos.tickets.get(ticketId)
      await this.markSetupDue(ticket, await this.workspaceOf(ticket))
    }
    await this.startNow(
      ticketId,
      { roleIds: [input.roleId], extraInstructions: input.extraInstructions, ...(input.roles ? { roles: input.roles } : {}) },
      [input.notice]
    )
  }

  private async sendNow(ticketId: string, text: string): Promise<void> {
    if (this.shuttingDown) throw new Error(SHUTTING_DOWN)
    if (this.stopRequested.has(ticketId)) throw new Error(NOT_WORKING)
    const run = await this.repos.runs.latest(ticketId)
    if (!run || run.endReason !== null) throw new Error(NOT_WORKING)
    const live = this.live.get(run.id)
    if (live) {
      if (live.ended) throw new Error(NOT_WORKING)
      // Logged before delivery, so it precedes anything the agent does in response.
      live.silentTurns = 0
      const settled = await this.repos.decisions.answerByMessage(run.id, text)
      await this.record(live, { kind: 'user_message', text })
      await this.announceSettled(ticketId, settled)
      const failure = await this.deliver(live, text)
      if (failure !== null) throw new Error(`The message was not delivered: ${failure}`)
      return
    }
    const ticket = await this.repos.tickets.get(ticketId)
    const settled = await this.repos.decisions.answerByMessage(run.id, text)
    const logged = await this.record(this.target(run, ticket), { kind: 'user_message', text })
    await this.announceSettled(ticketId, settled)
    // The message is the prompt, so a fallback digest leaves it out.
    await this.resume(run, text, logged.seq)
  }

  /** Tells every place showing the questions a message just settled. The agent got the message itself, nothing more. */
  private async announceSettled(ticketId: string, settled: Decision[]): Promise<void> {
    if (settled.length === 0) return
    const { workspaceId } = await this.repos.tickets.get(ticketId)
    for (const d of settled) this.announceDecision(d, workspaceId)
  }

  private async answerNow(decisionId: string, a: DecisionAnswer, via: CardVia): Promise<void> {
    const decision = await this.repos.decisions.get(decisionId)
    checkAnswer(decision, a)
    const folder = await this.openFolderDecision(decision.ticketId, decision.agentRunId)
    if (folder && folder.id !== decisionId) throw new Error(FOLDER_MISSING)
    const answered = await this.repos.decisions.answer(decisionId, a, via)
    const ticket = await this.repos.tickets.get(decision.ticketId)
    this.announceDecision(answered, ticket.workspaceId)

    if (decision.kind === 'permission') {
      this.waiters.get(decisionId)?.(a)
      return
    }

    // From here on the answer is recorded; if the run has ended, it simply stays recorded.
    const option = a as Extract<DecisionAnswer, { kind: 'option' }>
    const action = await this.repos.decisions.actionOf(decisionId)
    if (action && (await this.actOnAnswer(decision, action, option))) return
    const text = answerText(decision, option)
    const live = this.live.get(decision.agentRunId)
    if (live) {
      live.silentTurns = 0
      await this.deliver(live, text)
      return
    }
    // The agent's process is gone (for example after a restart): resume with the answer.
    const run = await this.repos.runs.latest(decision.ticketId)
    if (run && run.id === decision.agentRunId && run.endReason === null) await this.resume(run, text)
  }

  /**
   * Does what the answer to a decision Mainbus asked on a role's behalf calls for: a hand-back, or Take over.
   * Returns false when the answer is for the agent instead ("Keep going" on a reported problem). Runs inside
   * the ticket's queue, so it calls stopNow and handOnNow directly.
   */
  private async actOnAnswer(
    decision: Decision,
    action: DecisionAction,
    a: Extract<DecisionAnswer, { kind: 'option' }>
  ): Promise<boolean> {
    const chosen = decision.options[a.index]
    if (action.kind === 'missing_worktree') return this.answerMissingFolder(decision, a.index)
    if (action.kind === 'setup_failed') return this.answerSetupFailed(decision, a.index)
    if (action.kind === 'leftover_folder') return this.answerLeftover(decision, action, a.index)
    if (action.kind === 'round_trip' && chosen === TAKE_OVER) {
      await this.stopNow(decision.ticketId)
      return true
    }
    const handBack = action.kind === 'round_trip' ? chosen === KEEP_GOING : action.toRoleId !== null && chosen !== KEEP_GOING
    if (!handBack || action.toRoleId === null) return false

    const run = await this.repos.runs.latest(decision.ticketId)
    // The reporter has ended meanwhile (stopped, say): the answer stays recorded and nothing else happens.
    if (!run || run.id !== decision.agentRunId || run.endReason !== null) return true
    const { roles } = await this.repos.runs.ticketRun(run.ticketRunId)
    const from = roles.find((r) => r.id === action.fromRoleId)
    const to = roles.find((r) => r.id === action.toRoleId)
    if (!from || !to) return true
    const ticket = await this.repos.tickets.get(decision.ticketId)
    const note = a.note ? `\n\nThe user's note:\n${data('note', a.note)}` : ''
    const back = await this.handBack(this.target(run, ticket), from, to, action.details, true)
    if (!back) return true
    // The reporter's turn is over (it asked and ended it), so its process can go now.
    const live = this.live.get(run.id)
    if (live) void this.stopProcess(live)
    await this.handOnNow(back, problemText(from, action.details) + note)
    return true
  }

  /** The open decision about the run's missing folder, or null. */
  private openFolderDecision(ticketId: string, runId: string): Promise<Decision | null> {
    return this.openActionDecision(ticketId, runId, 'missing_worktree')
  }

  /** The open decision of this kind of action on the run, or null. */
  private async openActionDecision(ticketId: string, runId: string, kind: DecisionAction['kind']): Promise<Decision | null> {
    for (const d of await this.repos.decisions.unsettled(ticketId)) {
      if (d.agentRunId === runId && (await this.repos.decisions.actionOf(d.id))?.kind === kind) return d
    }
    return null
  }

  /** Recreate (option 0): the folder comes back from the ticket's branch and the run continues. Otherwise the run stops. */
  private async answerMissingFolder(decision: Decision, index: number): Promise<boolean> {
    if (index !== 0) {
      await this.stopNow(decision.ticketId)
      return true
    }
    const run = await this.repos.runs.latest(decision.ticketId)
    if (!run || run.id !== decision.agentRunId || run.endReason !== null) return true
    const ticket = await this.repos.tickets.get(decision.ticketId)
    const target = this.target(run, ticket)
    try {
      const workspace = await this.workspaceOf(ticket)
      await this.deps.worktrees.recreate(workspace, ticket)
      // A new folder, so the setup command is due again.
      await this.markSetupDue(ticket, workspace)
    } catch (err) {
      await this.record(target, { kind: 'error', message: errorText(err) })
      if (await this.repos.runs.end(run.id, 'failed')) await this.deps.onFailed?.({ workspaceId: ticket.workspaceId, ticketId: ticket.id, runId: run.id })
      this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
      this.kickQueue()
      return true
    }
    await this.resume(run, RESTART_TEXT)
    return true
  }

  private async stopNow(ticketId: string, expect?: RunExpectation): Promise<void> {
    // Everything queued before this stop has finished; later actions are not affected.
    this.stopRequested.delete(ticketId)
    this.slotKept.delete(ticketId)
    const run = await this.repos.runs.latest(ticketId)
    if (!run) return
    this.limitBypass.delete(run.id)
    if (expect && (run.id !== expect.agentRunId || run.endReason !== null)) throw new Error(MOVED_ON)
    const ticket = await this.repos.tickets.get(ticketId)
    const target = this.target(run, ticket)
    // The active role's process, and that of a role that handed off and has not ended its last turn yet.
    const lives = [...this.live.values()].filter((live) => live.ticketId === ticketId)
    for (const live of lives) live.ended = true
    // Stop the processes first and let their last events land, so nothing is recorded after `stopped`.
    await Promise.all(lives.map((live) => this.stopProcess(live)))
    await settleWithin(Promise.all(lives.map((live) => live.done)).then(() => {}), STOP_DRAIN_MS)
    if (await this.repos.runs.end(run.id, 'stopped')) await this.endStopped(target)
    await this.expirePending(target, () => true)
    this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
    // A stopped queued run has left the queue, and a stopped live one has freed its slot.
    this.kickQueue()
  }

  /** Records the stop of a run this call just ended, and puts its ticket back in Ready. */
  private async endStopped(target: ThreadTarget): Promise<void> {
    await this.record(target, { kind: 'stopped' })
    await this.repos.tickets.setManualColumn(target.ticketId, 'ready')
  }

  private async continueNow(ticketId: string): Promise<void> {
    if (this.shuttingDown) throw new Error(SHUTTING_DOWN)
    const run = await this.repos.runs.latest(ticketId)
    if (!run || run.endReason !== null || this.live.has(run.id)) {
      throw new Error('There is no paused agent to continue on this ticket')
    }
    // Only Resume ends the user's own pause, and a usage-limit pause ends with the limit or with Resume.
    if (run.limitPausedSeq !== null) throw new Error(PAUSED_BY_LIMIT)
    if (pausedByUser(await this.repos.runs.events(run.id))) throw new Error(PAUSED_BY_USER)
    await this.resume(run, CONTINUE_TEXT)
  }

  private async pauseNow(ticketId: string, expect?: RunExpectation): Promise<void> {
    const run = await this.repos.runs.latest(ticketId)
    if (expect && run?.id !== expect.agentRunId) throw new Error(MOVED_ON)
    const live = run && run.endReason === null ? this.live.get(run.id) : undefined
    if (!run || !live || live.ended) throw new Error(NOT_WORKING)
    // From here the agent gets no nudge, and its process ending is neither reported nor a usage-limit pause.
    live.ended = true
    const ticket = await this.repos.tickets.get(ticketId)
    // Recorded before the process goes, so the ticket shows Paused at once.
    await this.record(this.target(run, ticket), { kind: 'paused' })
    // The run stays open with its session, as after a restart: Resume continues it by session id.
    await this.halt(live)
    this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
    this.kickQueue()
  }

  private async redirectNow(ticketId: string, expect: RunExpectation, message: string, claim: () => Promise<boolean>, proposalId?: string): Promise<void> {
    if (this.shuttingDown) throw new Error(SHUTTING_DOWN)
    if (this.stopRequested.has(ticketId)) throw new Error(NOT_WORKING)
    const run = await this.repos.runs.latest(ticketId)
    if (!run || run.id !== expect.agentRunId || run.endReason !== null) throw new Error(MOVED_ON)
    const live = this.live.get(run.id)
    if (!live || live.ended || live.stopping) throw new Error(NOT_WORKING)
    if (!(await claim())) throw new Error(REDIRECT_STALE)
    // Logged before the interrupt, so it precedes anything the agent does in response.
    await this.record(live, { kind: 'redirected', role: live.role, text: message, ...(proposalId === undefined ? {} : { proposalId }) })
    live.silentTurns = 0
    await settleWithin(this.deps.runtime.interrupt(live.handle).catch(() => {}), STOP_DRAIN_MS)
    const failure = await this.deliver(live, message)
    if (failure !== null) throw new Error(`The message was not delivered: ${failure}`)
  }

  private async replaceNow(ticketId: string, expect: RunExpectation, request: ReplaceRequest): Promise<void> {
    if (this.shuttingDown) throw new Error(SHUTTING_DOWN)
    if (this.stopRequested.has(ticketId)) throw new Error(NOT_WORKING)
    const run = await this.repos.runs.latest(ticketId)
    if (run?.id !== expect.agentRunId) throw new Error(MOVED_ON)
    if (run.endReason !== null) throw new Error(NOT_WORKING)
    const ticket = await this.repos.tickets.get(ticketId)
    const target = this.target(run, ticket)
    // The ticket counts as working while the summary is written, so it never shows as paused or failed meanwhile.
    this.handingOn.add(ticketId)
    let launching = false
    try {
      // The fresh agent takes the replaced one's slot, when it had one.
      if (await this.holdsSlot(ticketId)) this.slotKept.add(ticketId)
      // A handed-off role's process may still be ending its last turn; it is stopped along with the active one.
      for (const live of [...this.live.values()].filter((l) => l.ticketId === ticketId)) await this.halt(live)
      this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })

      const { summary, source } = await this.summarise(run, target, (events, decisions) => replaceSummaryPrompt(events, decisions, run.role))
      // The old agent's own handoff, a hand-back or a stop may have ended the run meanwhile: then that stands.
      const { proposalId, suggestedBy, ...launchRequest } = request
      const next = await this.repos.runs.replace(run.id, { ...launchRequest, handoffSummary: summary })
      if (next === null) return
      await this.record(target, {
        kind: 'replaced',
        role: run.role,
        summary,
        source,
        ...(proposalId === undefined ? {} : { proposalId }),
        ...(suggestedBy === undefined ? {} : { suggestedBy })
      })
      // The replaced agent's process is gone, so nothing is left to receive any answer.
      await this.expirePending(target, (d) => d.agentRunId === run.id)
      // This step holds the ticket's queue, so the fresh agent launches here rather than behind it.
      launching = true
      try {
        await this.launchReplacement(next, summary)
      } finally {
        this.handingOn.delete(ticketId)
      }
    } finally {
      if (!launching && !(await this.awaitingLaunch(ticketId, run.id))) this.handingOn.delete(ticketId)
      this.slotKept.delete(ticketId)
      this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
      this.kickQueue()
    }
  }

  /** Launches the run that replaced another: a fresh session whose first message carries the handoff summary. */
  private async launchReplacement(run: AgentRunRow, summary: string): Promise<void> {
    await this.whileLaunching(run.ticketId, async () => {
      const prepared = await this.prepare(run.ticketId)
      const ticketRun = await this.repos.runs.ticketRun(run.ticketRunId)
      const launch: Launch = {
        ...prepared,
        role: launchRole(ticketRun.roles, run),
        ticketRunId: run.ticketRunId,
        handoffs: await this.handoffsBefore(run),
        extraInstructions: joinInstructions(ticketRun.extraInstructions, run.extraInstructions)
      }
      const decisions = await this.repos.decisions.forTicket(run.ticketId)
      const prompt =
        `${firstMessage(prepared.ticket)}\n\n` +
        `Handoff from the previous run: the ${run.role} before you got stuck and was replaced. You start afresh in the same worktree; ` +
        `this is what it left you:\n${data('previous-run-summary', summary)}`
      await this.launch(launch, run.id, prompt, decisions)
    })
  }

  /**
   * What happened to a stuck role in its ticket run, in plain words: each of its agents (oldest first) with its
   * stuck episodes and evidence, the redirect messages sent and whether it was replaced.
   */
  private async stuckAccount(run: AgentRunRow): Promise<string> {
    const runs = (await this.repos.runs.listForTicketRun(run.ticketRunId)).filter((r) => r.roleId === run.roleId)
    const episodes = await this.repos.stuck.forRuns(runs.map((r) => r.id))
    const replaced = runs.filter((r) => r.endReason === 'replaced').length
    const lines = [
      `The ${run.role} got stuck again after being replaced ${replaced} ${replaced === 1 ? 'time' : 'times'}, so Mainbus marked it Failed instead of offering another redirect or replacement. What was tried:`
    ]
    for (const [i, r] of runs.entries()) {
      const messages = (await this.repos.runs.events(r.id)).flatMap((e) => (e.event.kind === 'redirected' ? [e.event.text] : []))
      const parts: string[] = []
      let redirects = 0
      for (const ep of episodes.filter((e) => e.agentRunId === r.id)) {
        const evidence = ep.evidence.map((l) => oneLine(l).slice(0, 200)).join(' | ')
        let part = `It looked stuck (${STUCK_RULE_TEXT[ep.rule]}). Evidence: ${evidence}.`
        if (ep.redirectedAt !== null) part += ` It was redirected with: ${JSON.stringify(oneLine(messages[redirects++] ?? ''))}.`
        parts.push(part)
      }
      if (parts.length === 0) parts.push('It was not reported as stuck.')
      const end = r.id === run.id ? 'It is stuck again now.' : r.endReason === 'replaced' ? 'It was then replaced by a fresh agent.' : ''
      lines.push(`${i + 1}. The ${i === 0 ? 'first' : i === runs.length - 1 ? 'latest' : 'next'} ${run.role}: ${[...parts, end].filter(Boolean).join(' ')}`)
    }
    return lines.join('\n')
  }

  private async resumeNow(ticketId: string): Promise<void> {
    if (this.shuttingDown) throw new Error(SHUTTING_DOWN)
    const run = await this.repos.runs.latest(ticketId)
    if (!run || run.endReason !== null) throw new Error(NOTHING_PAUSED)
    const byLimit = run.limitPausedSeq !== null
    if (!byLimit && !pausedByUser(await this.repos.runs.events(run.id))) throw new Error(NOTHING_PAUSED)
    // Resuming a run the usage limit paused is the user trying early: it goes past the gate, and if it gets through the limit is over.
    if (byLimit) this.limitBypass.add(run.id)
    // The paused process may still be going down.
    const live = this.live.get(run.id)
    if (live) await settleWithin(live.done, STOP_DRAIN_MS)
    if (this.live.has(run.id)) throw new Error(STILL_STOPPING)
    await this.resume(run, RESUME_TEXT)
  }

  private async skipNow(ticketId: string, expect?: RunExpectation): Promise<void> {
    if (this.shuttingDown) throw new Error(SHUTTING_DOWN)
    if (this.stopRequested.has(ticketId)) throw new Error(NOT_WORKING)
    const run = await this.repos.runs.latest(ticketId)
    if (expect && run?.id !== expect.agentRunId) throw new Error(MOVED_ON)
    if (!run || run.endReason !== null) throw new Error(NOT_WORKING)
    const ticket = await this.repos.tickets.get(ticketId)
    const target = this.target(run, ticket)
    const next = await this.nextRole(run)
    // The ticket counts as working while the summary is written, so it never shows as paused or failed meanwhile.
    this.handingOn.add(ticketId)
    let launching = false
    try {
      // The next role takes the skipped one's slot, when it had one.
      if (next && (await this.holdsSlot(ticketId))) this.slotKept.add(ticketId)
      // A handed-off role's process may still be ending its last turn; it is stopped along with the active one.
      for (const live of [...this.live.values()].filter((l) => l.ticketId === ticketId)) await this.halt(live)
      this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })

      const { summary, source } = await this.summarise(run, target, (events, decisions) => skipSummaryPrompt(events, decisions, run.role, next?.name ?? null))
      // The skipped agent's own handoff, a hand-back or a stop may have ended the run meanwhile: then that stands.
      let nextRun: AgentRunRow | null = null
      if (next) {
        nextRun = await this.repos.runs.handOn(run.id, next, { skipped: true })
        if (nextRun === null) return
      } else if (!(await this.repos.runs.end(run.id, 'handoff', { skipped: true }))) {
        return
      }
      await this.record(target, {
        kind: 'handoff',
        summary,
        outcome: 'done',
        notesForNext: '',
        ...(next ? { to: next.name } : {}),
        skipped: { by: 'user', source }
      })
      // The skipped role's process is gone, so nothing is left to receive any answer.
      await this.expirePending(target, (d) => d.agentRunId === run.id)
      if (nextRun) {
        await this.record(this.target(nextRun, ticket), { kind: 'role_handoff', from: run.role, to: nextRun.role })
        const prompt = run.returnToRoleId === null ? CONTINUE_TEXT : returnText(run.role, summary, '')
        // This step holds the ticket's queue, so the next role launches here rather than behind it.
        launching = true
        await this.handOnNow(nextRun, prompt)
      } else {
        this.handingOn.delete(ticketId)
        // In Review now: the push and PR run here, once, as after the last role's own handoff.
        await this.publishNow(ticketId, false)
      }
    } finally {
      if (!launching && !(await this.awaitingLaunch(ticketId, run.id))) this.handingOn.delete(ticketId)
      if (!launching) this.slotKept.delete(ticketId)
      this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
      this.kickQueue()
    }
  }

  /**
   * True when a handoff or hand-back other than `runId`'s own ending has started a role whose launch is still
   * queued: it keeps the ticket marked as handing on until that launch clears it.
   */
  private async awaitingLaunch(ticketId: string, runId: string): Promise<boolean> {
    const latest = await this.repos.runs.latest(ticketId)
    return latest !== null && latest.id !== runId && latest.endReason === null && !this.live.has(latest.id)
  }

  /**
   * The handoff summary of a skipped or replaced role: written by a one-shot model call, through the runtime and the
   * user's own `claude`, from the role's log in this ticket run (`prompt` is what it is asked); or, when that fails,
   * is empty or takes too long, the digest.
   */
  private async summarise(
    run: AgentRunRow,
    target: ThreadTarget,
    prompt: (events: StoredEvent[], decisions: Decision[]) => string
  ): Promise<{ summary: string; source: 'summary' | 'digest' }> {
    const events: StoredEvent[] = []
    for (const earlier of await this.repos.runs.listForTicketRun(run.ticketRunId)) {
      if (earlier.roleId === run.roleId) events.push(...(await this.repos.runs.events(earlier.id)))
      if (earlier.id === run.id) break
    }
    const decisions = await this.repos.decisions.forTicket(run.ticketId)
    try {
      const { worktree } = await this.prepare(run.ticketId, false)
      const timeoutMs = this.deps.summaryTimeoutMs ?? SKIP_SUMMARY_MS
      const call = this.deps.runtime.summarize({
        cwd: worktree.path,
        tempDir: worktree.scratch,
        prompt: prompt(events, decisions),
        timeoutMs,
        // Recorded on the skipped or replaced run, which has events already; it may land after the wait gave up.
        onUsage: (u) => void this.record(target, { ...u, call: 'summary' }).catch(() => {})
      })
      // Bounded here too, whatever the runtime does with its timeout.
      const summary = (await withinMs(call, timeoutMs)).trim()
      if (summary) return { summary, source: 'summary' }
    } catch {
      // The digest below stands in.
    }
    return { summary: skippedDigest(events, decisions, run.role), source: 'digest' }
  }

  /** Interrupts a live agent's turn and stops its process, letting its last events land (all bounded). */
  private async halt(live: LiveRun): Promise<void> {
    live.ended = true
    if (!live.stopping) await settleWithin(this.deps.runtime.interrupt(live.handle).catch(() => {}), STOP_DRAIN_MS)
    await this.stopProcess(live)
    await settleWithin(live.done, STOP_DRAIN_MS)
  }

  private async moveToColumnNow(ticketId: string, column: 'backlog' | 'ready'): Promise<void> {
    const run = await this.repos.runs.latest(ticketId)
    if (run && run.endReason === null) throw new Error('Stop the agent on this ticket before moving it')
    // A handed-off or failed run keeps the ticket in Review or Needs you, so the move would not show.
    // Out of Done it does show: the ticket goes back to Review or Needs you.
    const current = await this.repos.tickets.get(ticketId)
    const ended = run && (run.endReason === 'handoff' || run.endReason === 'failed')
    if (ended && current.manualColumn !== 'done') throw new Error(ENDED_RUN_MOVE)
    const ticket = await this.repos.tickets.setManualColumn(ticketId, column)
    this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
  }

  private async moveToDoneNow(ticketId: string, opts: { deleteLeftover?: boolean } = {}): Promise<'done' | 'dirty' | 'asked'> {
    const ticket = await this.repos.tickets.get(ticketId)
    const wasDone = ticket.manualColumn === 'done'
    const where = { ticketId, workspaceId: ticket.workspaceId }
    const run = await this.repos.runs.latest(ticketId)
    const live = run ? this.live.get(run.id) : undefined
    if (live && !live.ended) throw new Error('The agent is still working on this ticket; stop it first')
    // A handed-off agent may not have ended its last turn yet.
    if (live) await this.stopProcess(live)

    // A process the agent left running holds the worktree's folder open, and would keep it from being removed.
    await this.sweepTicket(ticket)

    // Removal first: on 'dirty' a paused run must stay paused, so its session can still be continued.
    // Nothing can revive the agent in between, because this step holds the ticket's queue.
    if (ticket.worktreePath !== null && ticket.branch !== null) {
      const workspace = await this.workspaceOf(ticket)
      const outcome = await this.deps.worktrees.remove(ticket.id, workspace.repoPath, ticket.worktreePath, ticket.branch, {
        discard: false,
        leftover: { workspaceSlug: workspace.slug, delete: opts.deleteLeftover ?? false }
      })
      if (outcome === 'dirty') return 'dirty'
      if (outcome === 'leftover') return this.askAboutLeftover(ticket, workspace, run)
      await this.repos.tickets.setWorktree(ticket.id, ticket.branch, null)
    }
    if (run && run.endReason === null) {
      // A paused run ends here, so nothing can revive an agent on a Done ticket.
      if (await this.repos.runs.end(run.id, 'stopped')) await this.record(this.target(run, ticket), { kind: 'stopped' })
    }
    await this.repos.tickets.setManualColumn(ticket.id, 'done')
    await this.expirePending(where, () => true)
    this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
    this.kickQueue()
    await this.deps.onMovedToDone?.(ticket.id, wasDone)
    return 'done'
  }

  /**
   * The ticket's own folder is no longer a git worktree but holds files, so Mainbus asks before deleting it. It
   * does not use `ask`: that refuses a run that has ended, and a ticket in Review has an ended run. The ticket
   * stays where it was.
   */
  private async askAboutLeftover(ticket: Ticket, workspace: Workspace, run: AgentRunRow | null): Promise<'asked'> {
    const folder = ticket.worktreePath!
    const branch = ticket.branch!
    if (!run) throw new Error(`${folder} is no longer a git worktree but still holds files, so Mainbus left it alone. It needs looking at: check what is in it, then delete it or move the files out.`)
    const existing = await this.openActionDecision(ticket.id, run.id, 'leftover_folder')
    if (existing) {
      this.announceDecision(existing, ticket.workspaceId)
      return 'asked'
    }
    const found = await this.deps.worktrees.describeLeftover(workspace.repoPath, folder, branch)
    const decision = await this.repos.decisions.open(
      {
        ticketId: ticket.id,
        agentRunId: run.id,
        kind: 'question',
        question: leftoverQuestion(folder, branch, found),
        options: LEFTOVER_OPTIONS,
        recommended: null,
        allowAlways: false
      },
      { kind: 'leftover_folder', path: folder }
    )
    await this.record(this.target(run, ticket), { kind: 'decision', decisionId: decision.id })
    this.announceDecision(decision, ticket.workspaceId)
    return 'asked'
  }

  /** Delete (option 0): the folder is deleted and the ticket moves to Done. Keep it leaves everything as it was. */
  private async answerLeftover(decision: Decision, action: { path: string }, index: number): Promise<boolean> {
    if (index !== 0) return true
    const ticket = await this.repos.tickets.get(decision.ticketId)
    // Only the folder that was asked about; the ticket may have moved on since.
    if (ticket.manualColumn === 'done' || ticket.worktreePath !== action.path) return true
    try {
      await this.moveToDoneNow(ticket.id, { deleteLeftover: true })
    } catch (err) {
      const run = await this.repos.runs.latest(ticket.id)
      if (run) await this.record(this.target(run, ticket), { kind: 'notice', text: `The folder could not be deleted: ${errorText(err)}` })
      throw err
    }
    return true
  }

  /**
   * Pushes the branch of a ticket in Review and opens its PR, or only pushes when it has one. A failure is
   * recorded on the ticket and in its thread, and the ticket stays in Review. `retry` is the user asking:
   * then a ticket that can't be pushed is an error rather than nothing to do.
   */
  private async publishNow(ticketId: string, retry: boolean): Promise<void> {
    let ticket = await this.repos.tickets.get(ticketId)
    if (!retry && ticket.prError !== null) {
      // A failure from an earlier round is out of date once the agent has handed off again.
      ticket = await this.repos.tickets.setPrError(ticketId, null)
      this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
    }
    const workspace = await this.workspaceOf(ticket)
    const run = await this.repos.runs.latest(ticketId)
    const publisher = this.deps.pullRequests
    const { branch, worktreePath } = ticket
    if (!publisher || !workspace.openPrOnReview) return cannotPublish(retry, PR_SETTING_OFF)
    if (!run || run.endReason !== 'handoff' || ticket.manualColumn === 'done') return cannotPublish(retry, PR_NOT_IN_REVIEW)
    if (branch === null || worktreePath === null) return cannotPublish(retry, PR_NO_BRANCH)
    // An investigation's branch holds nothing but its report's commits: until one is saved there is nothing to push.
    if (ticket.kind === 'investigate' && ticket.reportCommit === null) return cannotPublish(retry, REPORT_NOT_SAVED)

    const events = await this.repos.runs.events(run.id)
    const handoff = events.findLast((e) => e.event.kind === 'handoff')?.event
    let handoffSummary = handoff?.kind === 'handoff' ? handoff.summary : null
    if (handoff?.kind === 'handoff' && handoff.skipped) {
      handoffSummary = `Generated by Mainbus because the ${run.role} was skipped.\n\n${handoff.summary}`
    }
    const result = await publisher.publish({
      ticket: { ...ticket, branch, worktreePath },
      baseBranch: workspace.baseBranch,
      handoffSummary
    })
    const target = this.target(run, ticket)
    if (result.ok) {
      await this.repos.tickets.setPr(ticketId, result.pr)
      await this.record(target, { kind: 'pull_request', branch, number: result.pr.number, url: result.pr.url, opened: result.opened })
    } else {
      await this.repos.tickets.setPrError(ticketId, result.reason)
      await this.record(target, { kind: 'notice', text: `${PR_FAILED}: ${result.reason}` })
    }
  }

  /**
   * Saves an Investigate ticket's report as a file in its worktree and commits it on its branch, then pushes and opens
   * the PR as publishNow does. The file's path is chosen once and kept, so a resubmitted report overwrites the same
   * file in a new commit. A failure is recorded on the ticket and in its thread; the report itself stays on the ticket.
   * `retry` is the user asking: then a ticket whose report can't be saved is an error rather than nothing to do.
   */
  private async saveReportNow(ticketId: string, retry: boolean): Promise<void> {
    const ticket = await this.repos.tickets.get(ticketId)
    const workspace = await this.workspaceOf(ticket)
    const run = await this.repos.runs.latest(ticketId)
    const saver = this.deps.reportFiles
    const { branch, worktreePath, report } = ticket
    if (ticket.kind !== 'investigate' || report === null) return cannotPublish(retry, NO_REPORT)
    if (!saver || !workspace.saveReports) return cannotPublish(retry, REPORTS_OFF)
    if (!run || run.endReason !== 'handoff' || ticket.manualColumn === 'done') return cannotPublish(retry, REPORT_NOT_IN_REVIEW)
    if (branch === null || worktreePath === null) return cannotPublish(retry, REPORT_NO_BRANCH)

    const date = reportDate(this.deps.now())
    let relPath = ticket.reportFile
    let result: SaveReportResult
    try {
      relPath ??= reportFilePath(workspace.reportsFolder, ticket, date)
      result = await saver.save({
        worktreePath,
        relPath,
        content: reportFileText(ticket, report, date),
        message: investigationTitle(ticket)
      })
    } catch (err) {
      result = { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
    const target = this.target(run, ticket)
    if (result.ok && relPath !== null) {
      await this.repos.tickets.setReportFile(ticketId, { path: relPath, commit: result.commit, error: null })
      await this.record(target, { kind: 'report_file', path: relPath, commit: result.commit, branch })
      await this.publishNow(ticketId, false)
    } else {
      const reason = result.ok ? 'there is no file to save it in' : result.reason
      await this.repos.tickets.setReportFile(ticketId, { path: relPath, commit: null, error: reason })
      await this.record(target, { kind: 'notice', text: `${REPORT_SAVE_FAILED}: ${reason}` })
    }
  }

  // --- launching (always inside a queued step) ---

  /**
   * Looking up the changed files happens here, before the run is created: from then on the ticket shows as working,
   * and the agent should start without another wait.
   */
  private async prepare(ticketId: string, withChanges = true): Promise<Prepared> {
    let ticket = await this.repos.tickets.get(ticketId)
    const workspace = await this.workspaceOf(ticket)
    const worktree = await this.deps.worktrees.ensure(workspace, ticket)
    ticket = await this.repos.tickets.setWorktree(ticket.id, worktree.branch, worktree.path)
    // A folder made just now is due the setup command (or none, when the workspace has no command or this build runs none).
    if (worktree.created) ticket = await this.markSetupDue(ticket, workspace)
    const changes = withChanges ? await this.changedFiles(workspace, worktree.path) : null
    return { ticket, workspace, worktree, changes }
  }

  /**
   * The role the run's handoff goes to: the role waiting on it after reporting a problem, else the role after
   * the run's own in its ticket run, or null when the run's role is the last.
   */
  private async nextRole(run: AgentRunRow): Promise<LineupRole | null> {
    const { roles } = await this.repos.runs.ticketRun(run.ticketRunId)
    if (run.returnToRoleId !== null) {
      const waiting = roles.find((r) => r.id === run.returnToRoleId)
      if (waiting) return waiting
    }
    const i = roles.findIndex((r) => r.id === run.roleId)
    return i >= 0 ? (roles[i + 1] ?? null) : null
  }

  /** The handoffs of the other roles before `run` in its ticket run, in order (its own role's are its own). */
  private async handoffsBefore(run: AgentRunRow): Promise<EarlierHandoff[]> {
    const handoffs: EarlierHandoff[] = []
    for (const earlier of await this.repos.runs.listForTicketRun(run.ticketRunId)) {
      if (earlier.id === run.id) break
      if (earlier.endReason !== 'handoff' || earlier.roleId === run.roleId) continue
      const event = (await this.repos.runs.events(earlier.id)).findLast((e) => e.event.kind === 'handoff')?.event
      if (event?.kind !== 'handoff') continue
      handoffs.push({
        role: earlier.role,
        summary: event.summary,
        ...(event.notesForNext !== undefined ? { notesForNext: event.notesForNext } : {}),
        ...(event.skipped ? { skipped: event.skipped.source } : {})
      })
    }
    return handoffs
  }

  /**
   * Launches the role a handoff or hand-back just started, with `prompt` as its next message; the ticket
   * counts as launching until this is over.
   */
  private async handOnNow(run: AgentRunRow, prompt: string): Promise<void> {
    try {
      await this.resume(run, prompt)
    } finally {
      this.handingOn.delete(run.ticketId)
      // The slot was the next role's to take; if it never launched, the slot is free again.
      this.slotKept.delete(run.ticketId)
      this.kickQueue()
    }
  }

  /**
   * Resumes the run's session with `prompt`; if that fails, starts a fresh agent with a digest of the
   * thread (events from seq `digestBefore` on are left out of the digest), including the role's earlier
   * runs in this ticket run. A role that was handed the ticket but never launched gets a fresh session with
   * its first message instead.
   */
  private async resume(run: AgentRunRow, prompt: string, digestBefore?: number, queued?: QueuedStart): Promise<void> {
    if (this.shuttingDown) return
    const current = await this.repos.runs.latest(run.ticketId)
    if (!current || current.id !== run.id || current.endReason !== null || this.live.has(run.id)) return
    if (current.queuedSeq !== null && !queued) {
      // Already waiting for a slot: it keeps its place, and starts with whatever was said meanwhile too.
      if (prompt !== CONTINUE_TEXT && prompt !== RESUME_TEXT && prompt !== RESTART_TEXT && prompt !== USAGE_RESUME_TEXT) await this.repos.runs.enqueue(run.id, prompt)
      return
    }
    // Nothing recreates a missing folder behind the user's back while they are deciding what to do about it.
    if (await this.openFolderDecision(run.ticketId, run.id)) throw new Error(FOLDER_MISSING)
    if (await this.openActionDecision(run.ticketId, run.id, 'setup_failed')) throw new Error(SETUP_FAILED_OPEN)
    await this.whileLaunching(run.ticketId, async () => {
      const prepared = await this.prepare(run.ticketId)
      const ticketRun = await this.repos.runs.ticketRun(current.ticketRunId)
      const launch: Launch = {
        ...prepared,
        role: launchRole(ticketRun.roles, current),
        ticketRunId: current.ticketRunId,
        handoffs: await this.handoffsBefore(current),
        extraInstructions: joinInstructions(ticketRun.extraInstructions, current.extraInstructions)
      }
      const events = await this.repos.runs.events(run.id)
      // A role handed a problem back, or returned to, worked in its earlier runs of this ticket run too.
      const before: StoredEvent[] = []
      for (const earlier of await this.repos.runs.listForTicketRun(current.ticketRunId)) {
        if (earlier.id === current.id) break
        // A replaced agent's log is not this one's: it got a summary of it instead.
        if (earlier.roleId === current.roleId && earlier.endReason !== 'replaced') before.push(...(await this.repos.runs.events(earlier.id)))
      }
      // The whole ticket's decisions, so a run made by Start again keeps the earlier runs' answers.
      const decisions = await this.repos.decisions.forTicket(run.ticketId)
      if (pausedByUser(events)) {
        // Whatever resumes it (Resume, a message, an answer), the user's pause is over.
        if (this.stopRequested.has(run.ticketId) || this.shuttingDown) return
        await this.record(this.target(current, launch.ticket), { kind: 'resumed' })
      }
      // The question about a failed setup is no sign of a launch either: nothing has run yet.
      const setupDecisions = new Set<string>()
      for (const d of decisions) if ((await this.repos.decisions.actionOf(d.id))?.kind === 'setup_failed') setupDecisions.add(d.id)
      const neverLaunched = [...before, ...events].every(
        (e) => NOT_LAUNCHED_KINDS.has(e.event.kind) || (e.event.kind === 'decision' && setupDecisions.has(e.event.decisionId))
      )
      if (current.sessionId === null && neverLaunched) {
        const handedBy = events.find((e) => e.event.kind === 'role_handoff')?.event
        const first = firstMessage(launch.ticket, handedBy?.kind === 'role_handoff' ? handedBy.from : undefined)
        const bare = prompt === CONTINUE_TEXT || prompt === RESUME_TEXT || prompt === RESTART_TEXT || prompt === USAGE_RESUME_TEXT
        // A queued run's message is the whole of what it starts with.
        const message = bare ? first : queued ? prompt : `${first}\n\n${prompt}`
        await this.launch(launch, run.id, message, decisions, undefined, queued)
        return
      }
      if (current.sessionId !== null) {
        try {
          await this.launch(launch, run.id, prompt, decisions, current.sessionId, queued)
          return
        } catch (err) {
          if (!(err instanceof ResumeFailedError)) throw err
        }
      }
      // launch() checks stopRequested first, so a stop queued meanwhile prevents the fresh agent. The resume that
      // failed had been given a slot, so the fresh agent has it too.
      const own = digestBefore === undefined ? events : events.filter((e) => e.seq < digestBefore)
      const digest = previousAttempt([...before, ...own], decisions, launch.role.name)
      this.admitting.add(run.ticketId)
      if (current.sessionId !== null) {
        await this.record(this.target(current, launch.ticket), {
          kind: 'notice',
          text: `Mainbus couldn't resume the ${launch.role.name}'s session, so it started a fresh one in the same folder with a summary of the previous attempt.`
        })
      }
      await this.launch(launch, run.id, `${digest}\n\n${prompt}`, decisions, undefined, { granted: true })
    })
  }

  /**
   * Marks the ticket as launching for the whole of `fn` (worktree setup included), so stateOf shows it working.
   * The board changes once more when it ends, so a launch that failed before its process started is seen too.
   */
  private async whileLaunching(ticketId: string, fn: () => Promise<void>): Promise<void> {
    this.launching.add(ticketId)
    try {
      await fn()
    } finally {
      this.launching.delete(ticketId)
      const ticket = await this.repos.tickets.get(ticketId).catch(() => null)
      if (ticket) this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
    }
  }

  private changedFiles(workspace: Workspace, wtPath: string): Promise<BranchChanges | null> {
    const lookup = Promise.resolve()
      .then(async () => this.deps.worktrees.changedFiles(wtPath, await (this.deps.baseRef?.(workspace) ?? workspace.baseBranch)))
      .catch(() => null)
    const timeout = new Promise<null>((resolve) => setTimeout(resolve, CHANGED_FILES_TIMEOUT_MS, null).unref())
    return Promise.race([lookup, timeout])
  }

  private async launch(
    launch: Launch,
    runId: string,
    prompt: string,
    decisions: Decision[],
    resumeSessionId?: string,
    slot?: QueuedStart
  ): Promise<void> {
    const { ticket, role, worktree } = launch
    if (this.stopRequested.has(ticket.id) || this.shuttingDown) return
    const target: ThreadTarget = {
      runId,
      ticketRunId: launch.ticketRunId,
      ticketId: ticket.id,
      workspaceId: ticket.workspaceId,
      role: role.name
    }
    // The workspace's setup command runs before the agent starts, and before it takes a slot: setup never holds one.
    const gate = await this.setupGate(launch, target)
    if (gate === null) {
      if (slot) this.admitting.delete(ticket.id)
      this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
      this.kickQueue()
      return
    }
    // Every agent start takes a slot, or waits for one in the queue. The run stays open and queued, and the ticket
    // keeps its column and phase.
    if (!slot && !(await this.admit(ticket.id, runId, prompt))) {
      this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
      this.kickQueue()
      return
    }
    // Ticket runs started before models were resolved at start hold nulls: those get the default table.
    const fallback = defaultFor(role.name)
    const endsWithReport = await this.endsWithReport(ticket, role.id, launch.ticketRunId)
    // The user's images, copied fresh into the scratch folder at every launch. A failed copy is no reason not to start.
    const attachments = (await this.deps.attachments?.sync(ticket.id, worktree.scratch).catch(() => [])) ?? []
    const { changes } = launch
    const baseTests = (await this.deps.baseTests?.(ticket.workspaceId).catch(() => null)) ?? null
    // This launch's own `claude` process: a resumed run starts another, which an earlier one's exit must not sweep.
    let claude: Promise<ProcessRef | null> | null = null
    const spec: RunSpec = {
      role: role.name,
      cwd: worktree.path,
      tempDir: worktree.scratch,
      ownBranch: worktree.branch,
      prompt,
      appendSystemPrompt: buildRolePrompt(
        role,
        ticket,
        decisions,
        launch.handoffs,
        launch.extraInstructions,
        endsWithReport,
        attachments,
        // Where Mainbus saves the report: the file already chosen, or the workspace's folder.
        endsWithReport && this.deps.reportFiles && launch.workspace.saveReports ? (ticket.reportFile ?? `${launch.workspace.reportsFolder}/`) : null,
        gate.setup,
        await this.repos.dependencies.blockersOf(ticket.id),
        changes,
        baseTests
      ),
      model: role.model ?? fallback.model,
      effort: role.effort ?? fallback.effort,
      toolProfile: role.toolProfile,
      endsWithReport,
      disallowedTools: DISALLOWED_TOOLS,
      // Edits and simple file commands in the scratch folder run without asking, as in the worktree.
      additionalDirectories: [worktree.scratch],
      ...(resumeSessionId !== undefined
        ? { resumeSessionId, usageBaseline: sessionUsageSoFar((await this.repos.runs.events(runId)).map((e) => e.event), resumeSessionId) }
        : {}),
      roleTools: this.roleTools(target, worktree.path, ticket.kind, endsWithReport),
      onPermission: (req) => this.onPermission(target, worktree, req),
      onProcessStart: (p) => void (claude = this.processStarted(target, p)),
      onProcessExit: () => void (claude && this.sweepRun(target, claude).catch(() => {}))
    }

    try {
      let handle: RunHandle
      try {
        handle = await this.deps.runtime.start(spec)
      } catch (err) {
        if (!(err instanceof ResumeFailedError)) await this.record(target, { kind: 'error', message: errorText(err) })
        throw err
      }
      if (this.shuttingDown) {
        // The app is quitting: stop the process without ending the run, so it shows paused next launch.
        await this.deps.runtime.stop(handle).catch(() => {})
        return
      }
      if (this.stopRequested.has(ticket.id)) {
        // Stopped while the process was starting: stop it before it does anything.
        await this.deps.runtime.stop(handle).catch(() => {})
        if (await this.repos.runs.end(runId, 'stopped')) await this.endStopped(target)
        return
      }
      if (this.deps.usage?.limited() && !this.limitBypass.has(runId)) {
        // The limit was hit while this process was starting: it goes down at once and the run is paused with the others.
        await this.deps.runtime.stop(handle).catch(() => {})
        await this.repos.runs.markLimitPaused([runId])
        await this.record(target, { kind: 'notice', text: this.deps.usage.pauseReason() })
        this.deps.usage.changed()
        return
      }
      await this.repos.runs.clearLimitPaused(runId)
      const live: LiveRun = {
        ...target,
        handle,
        nudge: nudgeText(ticket.kind, endsWithReport),
        silentTurns: 0,
        errorTurns: 0,
        askedThisTurn: false,
        ended: false,
        stopping: null,
        limit: null,
        startedAt: this.deps.now().getTime(),
        lastActivityAt: this.deps.now().getTime(),
        turnStartedAt: this.deps.now().getTime(),
        inTurn: true,
        done: Promise.resolve()
      }
      this.live.set(runId, live)
      live.done = this.pump(live)
    } finally {
      // The process is up (it holds the slot as a live agent) or the launch failed: either way the grant is spent.
      this.admitting.delete(ticket.id)
      this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
      this.kickQueue()
    }
  }

  // --- the agent's event stream ---

  private async pump(live: LiveRun): Promise<void> {
    try {
      for await (const event of this.deps.runtime.events(live.handle)) {
        try {
          await this.onEvent(live, event)
        } catch (err) {
          await this.record(live, { kind: 'error', message: `Mainbus could not handle an agent event: ${errorText(err)}` }).catch(
            () => {}
          )
        }
      }
    } catch (err) {
      if (isUsageLimitText(errorText(err))) this.limitHit(live, { resetsAt: null })
      await this.record(live, { kind: 'error', message: errorText(err) }).catch(() => {})
    }
    // The agents the usage limit paused are marked before they leave `live`, so they never show as merely paused.
    await this.limitMarking
    try {
      if (!live.ended) await this.record(live, { kind: 'process_exit', code: null })
      // A permission answer can no longer reach this process.
      await this.expirePending(live, (d) => d.kind === 'permission' && d.agentRunId === live.runId)
    } catch {
      // The database is gone (shutdown); there is nothing left to record.
    }
    this.live.delete(live.runId)
    this.deps.emit({ type: 'board.changed', workspaceId: live.workspaceId })
    this.kickQueue()
  }

  private async onEvent(live: LiveRun, event: AgentEvent): Promise<void> {
    live.lastActivityAt = this.deps.now().getTime()
    if (event.kind === 'turn_end') live.inTurn = false
    if ((event.kind === 'message' || event.kind === 'thinking') && event.partial) {
      // Streaming previews are shown but never stored; the final event follows.
      const preview: StoredEvent = { runId: live.runId, seq: 0, at: this.deps.now().toISOString(), event }
      this.deps.emit({ type: 'thread.appended', workspaceId: live.workspaceId, ticketId: live.ticketId, event: preview, run: threadRun(live) })
      return
    }
    if (event.kind === 'session') await this.repos.runs.setSession(live.runId, event.sessionId)
    if (event.kind === 'rate_limit') {
      const limit = limitFromEvent(event)
      const was = live.limit
      live.limit = limit
      // A rejected event enters the limited state once per run; the others show how close the windows are, and an
      // agent let past the gate that gets one has got through.
      if (limit === null || was === null) this.deps.usage?.rateLimit(event, live.runId)
      if (limit === null && this.limitBypass.has(live.runId)) this.deps.usage?.gotThrough()
    }
    if (event.kind === 'error' && isUsageLimitText(event.message)) this.limitHit(live, { resetsAt: null })
    await this.record(live, event)
    if (event.kind === 'turn_end') await this.onTurnEnd(live, event)
  }

  private async onTurnEnd(live: LiveRun, event: Extract<AgentEvent, { kind: 'turn_end' }>): Promise<void> {
    // The agent is going down with the app: no nudge, no failure.
    if (this.shuttingDown) return
    // An agent let past the gate finished a turn: the API answers again.
    if (event.ok && this.limitBypass.has(live.runId)) this.deps.usage?.gotThrough()
    if (live.ended) {
      // Handed off (or failed or stopped): the agent's last turn is over, so its process can go.
      void this.stopProcess(live)
      return
    }
    const asked = live.askedThisTurn
    live.askedThisTurn = false
    // Mainbus's own interrupt is not the agent going quiet.
    if (event.interrupted) return
    if (!event.ok && isUsageLimitText(event.error)) this.limitHit(live, { resetsAt: null })
    // A usage limit is not a failure, a silent turn or a reason to nudge: the pause (already under way) deals with it.
    if (this.deps.usage && !event.ok && live.limit !== null) return
    if (event.ok) live.limit = null
    if (!event.ok) {
      // An error (the API failing, say) is not the agent going quiet either; twice in a row fails the run.
      live.errorTurns++
      if (live.errorTurns >= 2) await this.fail(live, event.error ?? 'The agent turn failed')
      return
    }
    live.errorTurns = 0
    if (asked || (await this.repos.decisions.unsettled(live.ticketId)).length > 0) {
      live.silentTurns = 0
      return
    }
    live.silentTurns++
    if (live.silentTurns >= 2) {
      await this.fail(live, SILENT_FAILURE)
      return
    }
    await this.record(live, { kind: 'nudge', text: live.nudge })
    const failure = await this.deliver(live, live.nudge)
    if (failure !== null) await this.record(live, { kind: 'error', message: `Mainbus could not send the nudge: ${failure}` })
  }

  /** The run ran into the usage limit (once per run until a turn succeeds): the app enters the limited state. */
  private limitHit(live: LiveRun, limit: UsageLimit): void {
    if (!this.deps.usage || live.limit !== null) return
    live.limit = limit
    this.deps.usage.hit(limit, live.runId)
  }

  /**
   * The usage limit was hit: every working agent is interrupted and shown as Paused, the one that hit it first. The
   * agents are picked and marked ended in the same breath, so none is nudged, failed or counted as stuck, and the
   * rest (stopping the processes, marking the runs) goes on in the background: the event pump that calls this must
   * not wait for the pause, which waits for the pump. Agents waiting on a decision are not working and are left alone.
   */
  pauseForUsageLimit(firstRunId: string | null): void {
    const picked: LiveRun[] = []
    const first = firstRunId === null ? undefined : this.live.get(firstRunId)
    if (first && !first.ended && !first.stopping) picked.push(first)
    for (const live of this.live.values()) {
      if (live !== first && !live.ended && !live.stopping && live.inTurn) picked.push(live)
    }
    if (picked.length === 0) return
    for (const live of picked) {
      live.ended = true
      this.limitBypass.delete(live.runId)
    }
    const marking = this.repos.runs
      .markLimitPaused(picked.map((l) => l.runId))
      .catch(() => {})
      .then(() => this.deps.usage?.changed())
    this.limitMarking = Promise.all([this.limitMarking, marking])
    const reason = this.deps.usage?.pauseReason() || USAGE_PAUSED_FALLBACK
    for (const live of picked) {
      void (async () => {
        await marking
        await this.record(live, { kind: 'notice', text: reason })
        await this.halt(live)
        this.deps.emit({ type: 'board.changed', workspaceId: live.workspaceId })
        this.kickQueue()
      })().catch(() => {})
    }
  }

  /**
   * The limit is over: the agents it paused go to the front of the queue in the order they were paused, and start
   * as the concurrency cap allows. Agents already alive only lose their mark.
   */
  async releaseLimitPaused(): Promise<void> {
    const paused = await this.repos.runs.limitPaused()
    for (const run of paused) if (this.live.has(run.id)) await this.repos.runs.clearLimitPaused(run.id)
    const released = paused.filter((r) => !this.live.has(r.id))
    await this.repos.runs.releaseLimitPaused(
      released.map((r) => r.id),
      USAGE_RESUME_TEXT
    )
    for (const r of released) {
      const run = await this.repos.runs.get(r.id)
      if (run && run.queuedSeq !== null) await this.recordQueued(run.ticketId, run)
    }
    this.limitBypass.clear()
    this.queueHint = true
    await this.emitBoardChangedEverywhere()
    this.kickQueue()
  }

  async limitPausedCount(): Promise<number> {
    return (await this.repos.runs.limitPaused()).length
  }

  /**
   * Tries the limit with one agent: the first one it paused resumes, past the gate. False when there is none, or an
   * earlier try is still running and has not got through yet.
   */
  async probe(): Promise<boolean> {
    if ([...this.limitBypass].some((id) => this.live.get(id)?.ended === false)) return false
    const first = (await this.repos.runs.limitPaused()).find((r) => !this.live.has(r.id))
    if (!first || this.shuttingDown) return false
    this.limitBypass.add(first.id)
    await this.serial(first.ticketId, () => this.resume(first, USAGE_RESUME_TEXT)).catch(() => {})
    return true
  }

  /** Ends the run as failed, unless something else ended it first; `message` becomes the card's summary. */
  private async fail(live: LiveRun, message: string): Promise<void> {
    if (!(await this.repos.runs.end(live.runId, 'failed'))) return
    live.ended = true
    await this.record(live, { kind: 'error', message })
    void this.stopProcess(live)
    this.kickQueue()
    const ticket = await this.repos.tickets.get(live.ticketId)
    await this.deps.onFailed?.({ workspaceId: ticket.workspaceId, ticketId: live.ticketId, runId: live.runId })
  }

  /** Sends to a live agent. Returns null once delivered, or why it was not. */
  private async deliver(live: LiveRun, text: string): Promise<string | null> {
    if (live.ended || live.stopping) return 'the agent has stopped'
    try {
      await this.deps.runtime.send(live.handle, text)
      live.lastActivityAt = live.turnStartedAt = this.deps.now().getTime()
      live.inTurn = true
      return null
    } catch (err) {
      return errorText(err)
    }
  }

  private stopProcess(live: LiveRun): Promise<void> {
    live.stopping ??= this.deps.runtime.stop(live.handle).catch(() => {})
    return live.stopping
  }

  // --- role tools (called by the agent, not queued) ---

  /** Whether the role ends with submit_report: the last role of an Investigate ticket run. */
  private async endsWithReport(ticket: Ticket, roleId: string, ticketRunId: string): Promise<boolean> {
    if (ticket.kind !== 'investigate') return false
    return (await this.repos.runs.ticketRun(ticketRunId)).roles.at(-1)?.id === roleId
  }

  private roleTools(target: ThreadTarget, worktreePath: string, kind: TicketKind, endsWithReport: boolean): RoleToolHandlers {
    return {
      askUser: async ({ question, options, recommended }) => {
        if (options.length === 0) return 'Not asked: give the user at least one option to choose from.'
        const valid = recommended !== undefined && Number.isInteger(recommended) && recommended >= 0 && recommended < options.length
        return this.ask(target, question, options, valid ? recommended : null)
      },

      handoff: async ({ summary, notesForNext }) => {
        const run = await this.repos.runs.latest(target.ticketId)
        if (!run || run.id !== target.runId || run.endReason !== null) return RUN_ENDED
        if (endsWithReport) return MUST_SUBMIT_REPORT
        // Investigate roles never commit, so there is nothing to check.
        if (kind !== 'investigate' && (await this.deps.worktrees.hasUncommitted(worktreePath))) return COMMIT_FIRST
        const next = await this.nextRole(run)
        let nextRun: AgentRunRow | null = null
        if (next) {
          // The ticket counts as working from before the next role's run exists until its launch is over,
          // so it never shows in Review between roles.
          const wasHandingOn = this.handingOn.has(target.ticketId)
          this.handingOn.add(target.ticketId)
          // The next role takes this role's slot, so work that is waiting can't overtake a ticket mid-lineup.
          const keptSlot = !this.slotKept.has(target.ticketId) && (await this.holdsSlot(target.ticketId))
          if (keptSlot) this.slotKept.add(target.ticketId)
          nextRun = await this.repos.runs.handOn(target.runId, next)
          if (nextRun === null) {
            if (!wasHandingOn) this.handingOn.delete(target.ticketId)
            if (keptSlot) this.slotKept.delete(target.ticketId)
            return RUN_ENDED
          }
        } else if (!(await this.repos.runs.end(target.runId, 'handoff'))) {
          return RUN_ENDED
        }
        const live = this.live.get(target.runId)
        if (live) live.ended = true
        await this.record(target, {
          kind: 'handoff',
          summary,
          outcome: 'done',
          notesForNext,
          ...(next ? { to: next.name } : {})
        })
        // Nobody is left to receive an answer to this run's open questions.
        await this.expirePending(target, (d) => d.kind === 'question' && d.agentRunId === target.runId)
        if (nextRun) {
          const handedTo = nextRun
          const ticket = await this.repos.tickets.get(target.ticketId)
          await this.record(this.target(handedTo, ticket), { kind: 'role_handoff', from: target.role, to: handedTo.role })
          // A role that reported a problem and is waiting on this one resumes with this handoff as its message.
          const prompt = run.returnToRoleId === null ? CONTINUE_TEXT : returnText(target.role, summary, notesForNext)
          // The next role starts in the ticket's queue, without holding up this reply. Only the last role's
          // handoff pushes.
          void this.serial(target.ticketId, () => this.handOnNow(handedTo, prompt)).catch(() => {})
        } else {
          // The ticket is in Review now; the push and PR follow in its queue, without holding up this reply.
          void this.serial(target.ticketId, () => this.publishNow(target.ticketId, false))
            .catch(() => {})
            .then(() => this.deps.branchMoved?.(target.workspaceId))
        }
        return HANDED_OFF
      },

      submitReport: async ({ markdown }) => {
        const run = await this.repos.runs.latest(target.ticketId)
        if (!run || run.id !== target.runId || run.endReason !== null) return RUN_ENDED
        if (kind !== 'investigate') return NOT_INVESTIGATE
        if (!endsWithReport) return NOT_LAST_ROLE
        if (markdown.trim() === '') return EMPTY_REPORT
        // End the run first: a lost race must not leave a report on a run that someone else ended.
        if (!(await this.repos.runs.end(target.runId, 'handoff'))) return RUN_ENDED
        const live = this.live.get(target.runId)
        if (live) live.ended = true
        await this.repos.tickets.setReport(target.ticketId, markdown)
        await this.record(target, { kind: 'report', markdown })
        await this.expirePending(target, (d) => d.kind === 'question' && d.agentRunId === target.runId)
        // The ticket is in Review now; Mainbus commits the report's file, then pushes and opens the PR, in the
        // ticket's queue, without holding up this reply.
        void this.serial(target.ticketId, () => this.saveReportNow(target.ticketId, false)).catch(() => {})
        return REPORT_SUBMITTED
      },

      reportProblem: async ({ details }) => {
        const run = await this.repos.runs.latest(target.ticketId)
        if (!run || run.id !== target.runId || run.endReason !== null) return RUN_ENDED
        const { roles } = await this.repos.runs.ticketRun(run.ticketRunId)
        const from = roleIn(roles, run)
        const earlier = roles.slice(0, roles.indexOf(from))
        // The role set up to take problems back, if it is in this run; null hands back to the previous role.
        const configured = from.handBackTo === null ? earlier.at(-1) : earlier.find((r) => r.id === from.handBackTo)
        if (from.onProblem === 'hand_back' && configured) {
          if ((await this.roundTrips(run.ticketRunId, from.id, configured.id)) >= ROUND_TRIP_CAP) {
            return this.ask(
              target,
              `${from.name} and ${configured.name} have gone back and forth ${ROUND_TRIP_CAP} times: keep going, or take over?`,
              [KEEP_GOING, TAKE_OVER],
              null,
              { kind: 'round_trip', fromRoleId: from.id, toRoleId: configured.id, details }
            )
          }
          const back = await this.handBack(target, from, configured, details, false)
          if (!back) return RUN_ENDED
          // The earlier role starts in the ticket's queue, without holding up this reply; this agent's process
          // goes when its turn ends.
          void this.serial(target.ticketId, () => this.handOnNow(back, problemText(from, details))).catch(() => {})
          return `Handed back to ${configured.name}. End your turn now; when ${configured.name} hands off, its summary arrives as your next message.`
        }
        // Ask the user: on ask_me, or when the role to hand back to is not in this run.
        const to = configured ?? earlier.at(-1) ?? null
        return this.ask(
          target,
          `${from.name} reports a problem: ${details}`,
          to ? [`Hand back to ${to.name}`, KEEP_GOING] : [KEEP_GOING],
          null,
          { kind: 'problem', fromRoleId: from.id, toRoleId: to?.id ?? null, details }
        )
      },

      reportWaiting: async ({ reason, until }) => {
        if (!(await this.isOpen(target))) return RUN_ENDED
        const checked = checkWait({ reason, until }, this.deps.now())
        if (typeof checked === 'string') return checked
        const { wait, shortened } = checked
        // Replaces the run's earlier wait: the one in force is always the latest.
        await this.repos.runs.setDeclaredWait(target.runId, wait)
        await this.record(target, { kind: 'waiting', ...wait })
        if (shortened) {
          return `Recorded until ${clockTime(wait.until)} (${STUCK.maxWaitMs / 3_600_000} hours from now, the most allowed); call report_waiting again if you need longer. Handing off ends the wait. Go on with the wait now.`
        }
        return `Recorded: Mainbus expects you to be quiet until ${clockTime(wait.until)}. Calling report_waiting again replaces it, and handing off ends it. Go on with the wait now.`
      },

      checkCriterion: async ({ index }) => {
        if (!(await this.isOpen(target))) return RUN_ENDED
        const { criteria } = await this.repos.tickets.get(target.ticketId)
        if (criteria.length === 0) return 'Not checked: this ticket has no acceptance criteria.'
        const checked = Number.isInteger(index) ? await this.repos.tickets.checkCriterion(target.ticketId, index) : null
        if (!checked) return `Not checked: there is no criterion ${index}. This ticket's criteria are numbered 0 to ${criteria.length - 1}.`
        if (checked.wasChecked) return `Criterion ${index} was already checked.`
        await this.record(target, { kind: 'criterion_checked', index, text: checked.text })
        return `Checked ${index}: ${checked.text}`
      }
    }
  }

  /**
   * Opens a question to the user for the target's run. With an `action`, Mainbus asks on the role's behalf and
   * acts on the answer itself (see actOnAnswer). Returns what the agent is told.
   */
  private async ask(
    target: ThreadTarget,
    question: string,
    options: string[],
    recommended: number | null,
    action?: DecisionAction
  ): Promise<string> {
    const live = this.live.get(target.runId)
    if (live) live.askedThisTurn = true
    if (!(await this.isOpen(target))) return RUN_ENDED
    const decision = await this.repos.decisions.open(
      { ticketId: target.ticketId, agentRunId: target.runId, kind: 'question', question, options, recommended, allowAlways: false },
      action
    )
    if (!(await this.isOpen(target))) {
      await this.expireIfPending(decision.id, target.workspaceId)
      return RUN_ENDED
    }
    await this.record(target, { kind: 'decision', decisionId: decision.id })
    this.announceDecision(decision, target.workspaceId)
    return ASK_RECORDED
  }

  /**
   * Hand-backs from `fromRoleId` to `toRoleId` in the ticket run since the user last chose one: the user
   * choosing a hand-back (Keep going, or Hand back on a reported problem) starts the count again.
   */
  private async roundTrips(ticketRunId: string, fromRoleId: string, toRoleId: string): Promise<number> {
    let count = 0
    for (const run of await this.repos.runs.listForTicketRun(ticketRunId)) {
      if (run.endReason !== 'handed_back' || run.roleId !== fromRoleId) continue
      for (const { event } of await this.repos.runs.events(run.id)) {
        if (event.kind === 'hand_back' && event.toRoleId === toRoleId) count = event.byUser ? 0 : count + 1
      }
    }
    return count
  }

  /**
   * Hands the target's run (role `from`) back to `to`: starts `to`'s run, which carries on its session and
   * returns to `from` when it hands off, and ends the target's run as handed back. Returns `to`'s new run,
   * with the ticket marked as handing on until handOnNow launches it, or null when the run had already ended.
   */
  private async handBack(
    target: ThreadTarget,
    from: LineupRole,
    to: LineupRole,
    details: string,
    byUser: boolean
  ): Promise<AgentRunRow | null> {
    const wasHandingOn = this.handingOn.has(target.ticketId)
    this.handingOn.add(target.ticketId)
    // The role handed back to takes this role's slot, as a handoff's next role does.
    const keptSlot = !this.slotKept.has(target.ticketId) && (await this.holdsSlot(target.ticketId))
    if (keptSlot) this.slotKept.add(target.ticketId)
    const back = await this.repos.runs.handBack(target.runId, to, from.id)
    if (back === null) {
      if (!wasHandingOn) this.handingOn.delete(target.ticketId)
      if (keptSlot) this.slotKept.delete(target.ticketId)
      return null
    }
    const live = this.live.get(target.runId)
    if (live) live.ended = true
    await this.record(target, {
      kind: 'hand_back',
      from: from.name,
      to: to.name,
      fromRoleId: from.id,
      toRoleId: to.id,
      details,
      ...(byUser ? { byUser: true } : {})
    })
    // Nobody is left to receive an answer to this run's open questions.
    await this.expirePending(target, (d) => d.kind === 'question' && d.agentRunId === target.runId)
    const ticket = await this.repos.tickets.get(target.ticketId)
    await this.record(this.target(back, ticket), { kind: 'role_hand_back', from: from.name, to: to.name })
    return back
  }

  // --- permissions ---

  private async onPermission(
    target: ThreadTarget,
    worktree: Prepared['worktree'],
    req: PermissionRequest
  ): Promise<PermissionVerdict> {
    if (!(await this.isOpen(target))) return { allow: false, message: RUN_ENDED }
    // Before allow rules and unattended mode, so neither can let it through.
    if (isBackgroundShell(req.toolName, req.input)) return { allow: false, message: BACKGROUND_DENIED }
    // The same folders as the run's, so the guard and allow rules treat the scratch folder as inside.
    const folders = {
      worktree: worktree.path,
      additionalDirectories: [worktree.scratch],
      scratch: worktree.scratch,
      // Where the agent's shell is, so relative paths and cd are judged from there.
      ...(req.cwd !== undefined ? { cwd: req.cwd } : {})
    }
    const guard = guardReason(req.toolName, req.input, { ...folders, ownBranch: worktree.branch })
    const guarded = guard !== null
    const shell = isShellTool(req.toolName)
    const command = shell ? commandOf(req.input) : null
    const forcePush = command !== null && isDestructivePush(command)
    // Reading or printing credentials asks every time: no rule, not even an exact one, covers it.
    const secret = credentialReason(req.toolName, req.input, folders) !== null
    // "Always allow" would be a lie where no rule can allow the request: a force-push, an unparseable
    // command, a credential read, or a guarded non-shell request (its rule would cover the tool
    // everywhere, not this path).
    const noAlways = (command !== null && (forcePush || parseShell(command).opaque)) || secret || (guarded && !shell)

    if (!forcePush && !secret) {
      const rules = await this.repos.allowRules.list(target.workspaceId)
      // A guarded action is only covered by a rule for exactly this command.
      if (guarded ? isAllowed(rules.filter((r) => r.pattern?.startsWith('=')), req) : isAllowed(rules, req, folders)) {
        return { allow: true }
      }
    }

    // Unattended mode answers every card but the hard stops, and never saves a rule for what it allowed.
    // Force-pushes and credential reads are hard stops whatever the guard made of the command.
    if (this.unattended(target.workspaceId) && guard?.kind !== 'hard_stop' && !forcePush && !secret) {
      await this.record(target, { kind: 'notice', text: `${AUTO_ALLOWED}: ${describeRequest(req, target.role)}` })
      return { allow: true }
    }

    const decision = await this.repos.decisions.open({
      ticketId: target.ticketId,
      agentRunId: target.runId,
      kind: 'permission',
      // The guard's reason tells the user why Mainbus is asking.
      question: describeRequest(req, target.role) + (req.reason ? ` — ${req.reason}` : ''),
      request: requestParts(req, target.role, req.reason),
      options: PERMISSION_OPTIONS,
      recommended: null,
      allowAlways: !noAlways
    })
    const answer = this.waitForAnswer(decision.id, req.signal)
    if (await this.isOpen(target)) {
      await this.record(target, { kind: 'decision', decisionId: decision.id })
      this.announceDecision(decision, target.workspaceId)
    } else {
      await this.expireIfPending(decision.id, target.workspaceId)
    }

    const a = await answer
    if (a === null || a.kind !== 'permission') {
      await this.expireIfPending(decision.id, target.workspaceId)
      return { allow: false, message: 'The permission request was cancelled' }
    }
    if (a.choice === 'deny') return { allow: false, message: 'Denied by the user' + (a.note ? `: ${a.note}` : '') }
    if (a.choice === 'always_allow' && decision.allowAlways) {
      for (const rule of rulesFromRequest(target.workspaceId, req, { exact: guarded, folders })) await this.repos.allowRules.add(rule)
    }
    return { allow: true }
  }

  /** Resolves with the answer, or null if the request is aborted or the decision expires first. */
  private waitForAnswer(decisionId: string, signal: AbortSignal): Promise<DecisionAnswer | null> {
    return new Promise((resolve) => {
      const settle = (a: DecisionAnswer | null) => {
        signal.removeEventListener('abort', onAbort)
        this.waiters.delete(decisionId)
        resolve(a)
      }
      const onAbort = () => settle(null)
      if (signal.aborted) return settle(null)
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.set(decisionId, settle)
    })
  }

  // --- decisions ---

  private async expirePending(
    where: { ticketId: string; workspaceId: string },
    which: (d: Decision) => boolean
  ): Promise<void> {
    for (const d of await this.repos.decisions.unsettled(where.ticketId)) {
      if (which(d)) await this.expireIfPending(d.id, where.workspaceId)
    }
  }

  /** Expires the decision if it is still open (pending or deferred), and releases any agent waiting on it with no answer. */
  private async expireIfPending(decisionId: string, workspaceId: string): Promise<void> {
    const { status } = await this.repos.decisions.get(decisionId)
    if (status === 'pending' || status === 'deferred') {
      // expire() throws if someone settled it in the meantime; then there is nothing to do.
      const expired = await this.repos.decisions.expire(decisionId).catch(() => null)
      if (expired) this.announceDecision(expired, workspaceId)
    }
    this.waiters.get(decisionId)?.(null)
  }

  private announceDecision(decision: Decision, workspaceId: string): void {
    this.deps.emit({ type: 'decision.changed', workspaceId, decision })
    this.deps.emit({ type: 'board.changed', workspaceId })
  }

  // --- processes an agent left running ---

  /**
   * Remembers the run's `claude` process, with the start time the process table gives it, in memory and on the run.
   * The result settles with the process, or with null when processes are not swept.
   */
  private processStarted(target: ThreadTarget, p: SpawnedClaude): Promise<ProcessRef | null> {
    const sweeper = this.deps.processes
    if (!sweeper) return Promise.resolve(null)
    const known = (async (): Promise<ProcessRef> => {
      // The time just before the spawn stands in when the process is already gone.
      const startedAt = (await sweeper.startTime(p.pid).catch(() => null)) ?? p.spawnedAt
      const ref = { pid: p.pid, startedAt }
      await this.repos.runs.setProcess(target.runId, ref).catch(() => {})
      return ref
    })()
    this.processRefs.set(target.runId, known)
    return known
  }

  /**
   * Ends every process still running that descends from `claude`, a `claude` process of the run, and says so in
   * the run's thread; says nothing when there were none. Sweeps of one run follow one another. Rejects when the
   * processes could not be listed or ended.
   */
  private sweepRun(target: ThreadTarget, claude: Promise<ProcessRef | null> | ProcessRef | null): Promise<void> {
    const sweeper = this.deps.processes
    if (!sweeper) return Promise.resolve()
    const run = (this.sweeps.get(target.runId) ?? Promise.resolve()).then(async () => {
      const ref = await claude
      if (ref === null) return
      const ended = await sweeper.sweep(ref)
      // A process started since (the run was resumed) keeps its record.
      if (this.processRefs.get(target.runId) === claude || !(claude instanceof Promise)) {
        this.processRefs.delete(target.runId)
        await this.repos.runs.setProcess(target.runId, null)
      }
      const notice = endedNotice(target.role, ended)
      if (notice !== null) await this.record(target, { kind: 'notice', text: notice })
    })
    const tail = run.catch(() => {})
    this.sweeps.set(target.runId, tail)
    void tail.then(() => {
      if (this.sweeps.get(target.runId) === tail) this.sweeps.delete(target.runId)
    })
    return run
  }

  /**
   * Sweeps every run of the ticket by the process kept on it, so what was left before a restart is caught too.
   * A failure is not fatal here: the removal that follows reports what still holds the folder.
   */
  private async sweepTicket(ticket: Ticket): Promise<void> {
    if (!this.deps.processes) return
    for (const run of await this.repos.runs.listForTicket(ticket.id)) {
      const known = this.processRefs.get(run.id)
      const stored = run.processPid !== null && run.processStartedAt !== null ? { pid: run.processPid, startedAt: run.processStartedAt } : null
      if (known === undefined && stored === null) continue
      await this.sweepRun(this.target(run, ticket), known ?? stored).catch(() => {})
    }
  }

  // --- the workspace's setup command ---

  /** Records that the new folder awaits the setup command, or that there is none to run. */
  private markSetupDue(ticket: Ticket, workspace: Workspace): Promise<Ticket> {
    const due: TicketSetup | null =
      workspace.setupCommand !== '' && this.deps.setup
        ? { state: 'pending', command: workspace.setupCommand, exitCode: null, timedOut: false, tail: '' }
        : null
    return this.repos.tickets.setSetup(ticket.id, due)
  }

  /**
   * Runs before every launch. Returns what the role's prompt says of setup, or null when the role must not start now:
   * setup was stopped, or it failed and the user is asked what to do (Retry, Start without setup, Stop).
   */
  private async setupGate(launch: Launch, target: ThreadTarget): Promise<{ setup: TicketSetup | null } | null> {
    const { ticket, workspace, worktree } = launch
    const state = ticket.setup
    if (state === null || state.state === 'succeeded' || state.state === 'skipped') return { setup: state }
    if (!this.deps.setup) return { setup: null }
    if (workspace.setupCommand === '') {
      // The command was removed from the workspace since.
      await this.repos.tickets.setSetup(ticket.id, null)
      return { setup: null }
    }
    // Pending (not run yet, or cut short), or failed and being retried.
    const result = await this.runSetup(target, workspace, worktree, false)
    if (result.outcome === 'succeeded') return { setup: result.setup }
    if (result.outcome === 'stopped') return null
    const why = result.setup.timedOut
      ? `timed out after ${workspace.setupTimeoutMinutes} `+ (workspace.setupTimeoutMinutes === 1 ? 'minute' : 'minutes')
      : result.setup.exitCode === null
        ? "couldn't run"
        : `failed with exit code ${result.setup.exitCode}`
    await this.ask(
      target,
      `The workspace's setup command (${oneLine(result.setup.command)}) ${why} in this ticket's folder, so the ${target.role} hasn't started. Retry runs it again; Start without setup starts the ${target.role} and tells it setup failed.`,
      ['Retry', 'Start without setup', 'Stop'],
      0,
      { kind: 'setup_failed' }
    )
    return null
  }

  /**
   * Runs the workspace's setup command in the ticket's folder and records the outcome: the ticket's setup state and a
   * Setup entry in the run's thread. A stop or shutdown ends it, and the state goes back to pending, so the next
   * start runs it again. Mainbus runs it itself, outside the agents' permissions; it holds no agent slot.
   */
  private async runSetup(
    target: ThreadTarget,
    workspace: Workspace,
    folder: { path: string; scratch: string },
    again: boolean
  ): Promise<{ outcome: 'succeeded' | 'failed' | 'timed_out' | 'stopped'; setup: TicketSetup }> {
    const command = workspace.setupCommand
    const controller = new AbortController()
    let finished!: () => void
    const done = new Promise<void>((resolve) => (finished = resolve))
    this.setups.set(target.ticketId, { controller, done })
    this.settingUp.add(target.ticketId)
    this.deps.emit({ type: 'board.changed', workspaceId: target.workspaceId })
    try {
      // A stop that came before the command could be registered has nothing to abort yet.
      if (this.stopRequested.has(target.ticketId) || this.shuttingDown) controller.abort()
      const started = this.deps.now()
      const logPath = path.join(folder.scratch, `setup-${started.toISOString().replace(/[:.]/g, '-')}.log`)
      const result = await this.deps
        .setup!({
          command,
          cwd: folder.path,
          tempDir: folder.scratch,
          timeoutMs: workspace.setupTimeoutMinutes * 60_000,
          signal: controller.signal,
          logPath
        })
        .catch((err: unknown) => ({ exitCode: null, timedOut: false, aborted: false, tail: [errorText(err)] }))
      const outcome = result.aborted ? 'stopped' : result.timedOut ? 'timed_out' : result.exitCode === 0 ? 'succeeded' : 'failed'
      const setup: TicketSetup = {
        state: outcome === 'stopped' ? 'pending' : outcome === 'succeeded' ? 'succeeded' : 'failed',
        command,
        exitCode: result.exitCode,
        timedOut: outcome === 'timed_out',
        tail: result.tail.join('\n')
      }
      await this.repos.tickets.setSetup(target.ticketId, setup)
      await this.record(target, {
        kind: 'setup',
        command,
        outcome,
        exitCode: result.exitCode,
        durationMs: this.deps.now().getTime() - started.getTime(),
        tail: result.tail,
        log: logPath,
        ...(again ? { again: true as const } : {})
      })
      return { outcome, setup }
    } finally {
      this.settingUp.delete(target.ticketId)
      this.setups.delete(target.ticketId)
      finished()
      this.deps.emit({ type: 'board.changed', workspaceId: target.workspaceId })
    }
  }

  /** Retry (0) runs setup again as the run launches; Start without setup (1) goes on without it; anything else stops the run. */
  private async answerSetupFailed(decision: Decision, index: number): Promise<boolean> {
    if (index !== 0 && index !== 1) {
      await this.stopNow(decision.ticketId)
      return true
    }
    const run = await this.repos.runs.latest(decision.ticketId)
    if (!run || run.id !== decision.agentRunId || run.endReason !== null) return true
    if (index === 1) {
      const ticket = await this.repos.tickets.get(decision.ticketId)
      if (ticket.setup) await this.repos.tickets.setSetup(ticket.id, { ...ticket.setup, state: 'skipped' })
    }
    await this.resume(run, CONTINUE_TEXT)
    return true
  }

  /** Runs the workspace's setup command again in the ticket's folder, while no role is working. */
  runSetupAgain(ticketId: string): Promise<void> {
    return this.serial(ticketId, () => this.runSetupAgainNow(ticketId))
  }

  private async runSetupAgainNow(ticketId: string): Promise<void> {
    if (this.shuttingDown) throw new Error(SHUTTING_DOWN)
    const ticket = await this.repos.tickets.get(ticketId)
    if (ticket.manualColumn === 'done') throw new Error('A ticket in Done has no folder to set up')
    if (ticket.worktreePath === null || !(await pathExists(ticket.worktreePath))) throw new Error("This ticket's folder doesn't exist")
    const workspace = await this.workspaceOf(ticket)
    if (workspace.setupCommand === '' || !this.deps.setup) throw new Error('This workspace has no setup command: set one in the workspace settings first')
    if (this.settingUp.has(ticketId)) throw new Error('Setup is already running on this ticket')
    if (this.isLaunching(ticketId) || [...this.live.values()].some((l) => l.ticketId === ticketId && !l.ended)) {
      throw new Error('An agent is working on this ticket: wait for it to finish or stop it first')
    }
    const run = await this.repos.runs.latest(ticketId)
    if (!run) throw new Error('Start the ticket first: its setup runs then')
    if (run.endReason === null && run.queuedSeq !== null) throw new Error('This ticket is waiting for a free agent slot: stop it first')
    if (await this.openActionDecision(ticketId, run.id, 'setup_failed')) throw new Error('Answer the decision about the failed setup first: use Retry')
    // The folder exists, so this only finds its scratch folder.
    const folder = await this.deps.worktrees.ensure(workspace, ticket)
    await this.runSetup(this.target(run, ticket), workspace, folder, true)
  }

  // --- helpers ---

  private async record(target: ThreadTarget, event: ThreadEvent): Promise<StoredEvent> {
    const stored = await this.repos.runs.append(target.runId, event)
    this.deps.emit({ type: 'thread.appended', workspaceId: target.workspaceId, ticketId: target.ticketId, event: stored, run: threadRun(target) })
    this.deps.emit({ type: 'board.changed', workspaceId: target.workspaceId })
    return stored
  }

  /** True while the target run is its ticket's latest run and has not ended. */
  private async isOpen(target: ThreadTarget): Promise<boolean> {
    const run = await this.repos.runs.latest(target.ticketId)
    return run !== null && run.id === target.runId && run.endReason === null
  }

  private target(run: AgentRunRow, ticket: Ticket): ThreadTarget {
    return { runId: run.id, ticketRunId: run.ticketRunId, ticketId: ticket.id, workspaceId: ticket.workspaceId, role: run.role }
  }

  private async workspaceOf(ticket: Ticket): Promise<Workspace> {
    const workspace = await this.repos.workspaces.get(ticket.workspaceId)
    if (!workspace) throw new Error(`The workspace of ticket ${ticket.id} was removed`)
    return workspace
  }
}

/** The run's role in its ticket run's snapshot `roles`. */
function roleIn(roles: LineupRole[], run: AgentRunRow): LineupRole {
  const role = roles.find((r) => r.id === run.roleId)
  if (!role) throw new Error(`The role of run ${run.id} is missing from its ticket run`)
  return role
}

/** The run's role as it launches: the snapshot's, with the model and effort the run itself was started with. */
function launchRole(roles: LineupRole[], run: AgentRunRow): LineupRole {
  const role = roleIn(roles, run)
  return { ...role, ...(run.model !== null ? { model: run.model } : {}), ...(run.effort !== null ? { effort: run.effort as Effort } : {}) }
}

/** The ticket run's extra instructions, then the ones the user added for one run. */
function joinInstructions(ticketRun: string | null, run: string | null): string | null {
  return ticketRun !== null && run !== null ? `${ticketRun}

${run}` : (ticketRun ?? run)
}

/** The run a thread event of `target` belongs to, as the renderer sees it. */
function threadRun(target: ThreadTarget): ThreadRun {
  return { id: target.runId, ticketRunId: target.ticketRunId, role: target.role }
}

/** What a role's thread can hold before its agent was ever launched: the handoff to it, and messages for it. */
const NOT_LAUNCHED_KINDS = new Set<ThreadEvent['kind']>(['role_handoff', 'role_hand_back', 'user_message', 'paused', 'resumed', 'setup', 'queued'])

/** The message a role gets when a later role hands a problem back to it. */
function problemText(from: LineupRole, details: string): string {
  return `${from.name} reports a problem:\n${data('problem', details)}`
}

/** The message a role waiting on an earlier one gets when that role hands off. */
function returnText(from: string, summary: string, notesForNext: string): string {
  const notes = notesForNext ? `\n${data('notes-for-next', notesForNext)}` : ''
  return `${from} handed the ticket back to you after your report. Its summary:\n${data('handoff-summary', summary)}${notes}`
}

/** The lineup roles to run, in lineup order: those in `roleIds`, or every one. */
function pickRoles(lineup: LineupRole[], roleIds: string[] | undefined): LineupRole[] {
  if (roleIds === undefined) {
    if (lineup.length === 0) throw new Error('This workspace has no roles')
    return lineup
  }
  if (!Array.isArray(roleIds) || roleIds.length === 0) throw new Error(NO_ROLES)
  const ids = new Set(lineup.map((r) => r.id))
  const unknown = roleIds.find((id) => !ids.has(id))
  if (unknown !== undefined) throw new Error(`There is no role ${JSON.stringify(unknown)} in this lineup`)
  return lineup.filter((r) => roleIds.includes(r.id))
}

/**
 * Checks a start's model, effort and extra instructions against the `picked` roles. Returns the user's choices by
 * role id, and the extra instructions trimmed, or null when there are none.
 */
export function checkStartOptions(
  picked: LineupRole[],
  opts: StartOptions
): { roles: Record<string, { model?: string; effort?: Effort }>; extraInstructions: string | null } {
  const roles: Record<string, { model?: string; effort?: Effort }> = {}
  if (opts.roles !== undefined) {
    if (typeof opts.roles !== 'object' || opts.roles === null) throw new Error('The roles to start are not valid')
    for (const [id, choice] of Object.entries(opts.roles)) {
      const role = picked.find((r) => r.id === id)
      if (!role) throw new Error(`There is no role ${JSON.stringify(id)} in this start`)
      const { model, effort } = choice ?? {}
      if (model !== undefined && (typeof model !== 'string' || !modelAllowed(role, model))) {
        throw new Error(`${role.name} has an unknown model: ${JSON.stringify(model)}`)
      }
      if (effort !== undefined && !EFFORTS.includes(effort)) {
        throw new Error(`${role.name} has an unknown effort: ${JSON.stringify(effort)}`)
      }
      roles[id] = { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) }
    }
  }
  const extra = opts.extraInstructions
  if (extra !== undefined && typeof extra !== 'string') throw new Error('Extra instructions must be text')
  if (extra !== undefined && extra.length > EXTRA_INSTRUCTIONS_MAX) {
    throw new Error(`Extra instructions must be at most ${EXTRA_INSTRUCTIONS_MAX} characters`)
  }
  const trimmed = extra?.trim() ?? ''
  return { roles, extraInstructions: trimmed === '' ? null : trimmed }
}

/** The most characters of a wait's reason that are kept. */
const WAIT_REASON_MAX = 300
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

/**
 * Checks the arguments of report_waiting: the declared wait, with `until` as a full ISO date-time, or the text
 * that tells the agent why it was not recorded. `until` must be in the future; one more than two hours from `now`
 * is shortened to two hours, and `shortened` says so.
 */
export function checkWait(a: { reason: unknown; until: unknown }, now: Date): { wait: DeclaredWait; shortened: boolean } | string {
  const reason = typeof a.reason === 'string' ? oneLine(a.reason).trim().slice(0, WAIT_REASON_MAX) : ''
  if (reason === '') return 'Not recorded: say what you are waiting for.'
  const until = typeof a.until === 'string' && ISO_DATE_TIME.test(a.until) ? Date.parse(a.until) : NaN
  if (Number.isNaN(until)) return 'Not recorded: until must be an ISO date-time, such as 2026-11-02T14:30:00Z.'
  if (until <= now.getTime()) return 'Not recorded: until is not in the future. Give the time the wait should end.'
  const latest = now.getTime() + STUCK.maxWaitMs
  return { wait: { reason, until: new Date(Math.min(until, latest)).toISOString() }, shortened: until > latest }
}

/** True when the run's thread ends on a usage limit: no turn has succeeded since one was reported. */
function endedOnUsageLimit(events: StoredEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!.event
    if (e.kind === 'turn_end' && e.ok) return false
    if (e.kind === 'rate_limit') return limitFromEvent(e) !== null
    if (e.kind === 'turn_end' && isUsageLimitText(e.error)) return true
    if (e.kind === 'error' && isUsageLimitText(e.message)) return true
  }
  return false
}

/** There is nothing to push: an error when the user asked for it, nothing to do when it came after a handoff. */
function cannotPublish(retry: boolean, why: string): void {
  if (retry) throw new Error(why)
}

function checkAnswer(decision: Decision, a: DecisionAnswer): void {
  if (decision.kind === 'permission') {
    if (a.kind !== 'permission') throw new Error('A permission decision needs a permission answer')
    if (a.choice === 'always_allow' && !decision.allowAlways) {
      throw new Error('"Always allow" is not offered for this request; allow it once or deny it')
    }
    return
  }
  if (a.kind !== 'option' || !Number.isInteger(a.index) || a.index < 0 || a.index >= decision.options.length) {
    throw new Error('A question needs one of its options as the answer')
  }
}

function answerText(decision: Decision, a: Extract<DecisionAnswer, { kind: 'option' }>): string {
  return `Answer: ${decision.options[a.index]}` + (a.note ? `\nNote: ${a.note}` : '')
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Settles as `p` does, or rejects once `ms` have passed. */
export async function withinMs<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_resolve, reject) => (timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms)))
  try {
    return await Promise.race([p, late])
  } finally {
    clearTimeout(timer)
  }
}

/** Waits for `p`, but no longer than `ms`. */
async function settleWithin(p: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const gaveUp = new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))
  await Promise.race([p, gaveUp])
  clearTimeout(timer)
}

async function pathExists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false
  )
}
