import type { EngineEvent } from '../../shared/api'
import type {
  Decision,
  DecisionAnswer,
  Effort,
  LineupRole,
  Phase,
  StartOptions,
  StripRole,
  Ticket,
  TicketState,
  Workspace
} from '../../shared/domain'
import type { AgentEvent, StoredEvent, ThreadEvent, ThreadRun } from '../../shared/events'
import { defaultFor, EFFORTS, EXTRA_INSTRUCTIONS_MAX, modelAllowed, resolveModelEffort } from '../../shared/models'
import type { PublishInput, PublishResult } from '../git/pullRequests'
import type { WorktreeManager } from '../git/worktrees'
import { credentialReason } from '../permissions/credentials'
import { guardReason } from '../permissions/guard'
import { commandOf, describeRequest, isAllowed, isDestructivePush, isShellTool, rulesFromRequest } from '../permissions/policy'
import { parseShell } from '../permissions/shell'
import { DISALLOWED_TOOLS } from '../roles/hardening'
import { buildRolePrompt, data, firstMessage, type EarlierHandoff } from '../roles/prompt'
import {
  ResumeFailedError,
  type AgentRuntime,
  type PermissionRequest,
  type PermissionVerdict,
  type RoleToolHandlers,
  type RunHandle,
  type RunSpec
} from '../runtime/types'
import { currentState, pausedByUser } from '../state/currentState'
import { lineupStrip } from '../state/lineupStrip'
import type { Repos } from '../store'
import type { DecisionAction } from '../store/decisions'
import type { AgentRunRow } from '../store/runs'
import { previousAttempt, skippedDigest, skipSummaryPrompt } from './digest'
import { isUsageLimitText, limitFromEvent, type UsageLimit } from './usageLimit'

export interface RunnerDeps {
  repos: Repos
  worktrees: WorktreeManager
  runtime: AgentRuntime
  now: () => Date
  emit: (e: EngineEvent) => void
  /**
   * True while unattended mode is on: permission requests that aren't hard stops are allowed without a card,
   * and a run stopped by a usage limit is paused (its process stopped, the run kept open) rather than left idle.
   */
  unattended?: () => boolean
  /**
   * Pushes a handed-off ticket's branch and opens its pull request, when the workspace asks for that.
   * Mainbus runs it itself, after the handoff: it never goes through the agent's permissions.
   */
  pullRequests?: { publish(input: PublishInput): Promise<PublishResult> }
  /** How long a skipped role's summary call may take before the digest is used instead (tests shorten it). */
  summaryTimeoutMs?: number
}

export const NUDGE_TEXT =
  'You ended your turn without asking the user or handing off. If you are done, commit and call mcp__mainbus__handoff. If you need the user, call mcp__mainbus__ask_user. Otherwise continue.'
const CONTINUE_TEXT = 'Continue where you left off.'
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
const RUN_ENDED = 'This run has ended.'
const NOT_WORKING = 'No agent is working on this ticket'
export const MOVED_ON = 'The ticket has moved on: that role is no longer the active one'

/** The run an action was meant for; the action fails rather than act on another role. */
export interface RunExpectation {
  agentRunId: string
}
const ENDED_RUN_MOVE = 'Start again or move to Done'
const SILENT_FAILURE = 'Ended two turns in a row without asking the user or handing off'
const PERMISSION_OPTIONS = ['Allow once', 'Always allow in this workspace', 'Deny']
/** How long stop() waits for the agent's remaining events after the process is told to stop. */
const STOP_DRAIN_MS = 2000
/** How long shutdown waits for launches and queued user actions to finish before it drains the live agents. */
const SHUTDOWN_SETTLE_MS = 5000
const SHUTTING_DOWN = 'Mainbus is shutting down'
const USAGE_LIMIT_PAUSE = 'Paused by the usage limit. Unattended mode continues this ticket when the limit resets.'
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
  /** Settles when the event pump has finished. */
  done: Promise<void>
}

/** A ticket with its worktree ready. */
interface Prepared {
  ticket: Ticket
  workspace: Workspace
  /** `scratch` is the ticket's scratch folder: its agents' temp folder, writable like the worktree. */
  worktree: { branch: string; path: string; scratch: string }
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
  /** Permission decisions an agent is waiting on, by decision id. */
  private readonly waiters = new Map<string, PermissionWaiter>()
  /** Tickets whose run was paused by a usage limit in unattended mode, until it is resumed, started or stopped. */
  private readonly limited = new Map<string, UsageLimit>()

  constructor(private readonly deps: RunnerDeps) {
    this.repos = deps.repos
  }

  /** The usage limit that paused this ticket's run, if one did and nothing has touched the run since. */
  usageLimit(ticketId: string): UsageLimit | undefined {
    return this.limited.get(ticketId)
  }

  /**
   * True while the ticket is being launched (worktree setup and process start), before or after its run exists,
   * and from one role handing off until the next role's launch is over.
   */
  isLaunching(ticketId: string): boolean {
    return this.launching.has(ticketId) || this.handingOn.has(ticketId)
  }

  private unattended(): boolean {
    return this.deps.unattended?.() ?? false
  }

  /** Runs the ticket through its lineup as a new ticket run: the roles in `opts.roleIds`, or all of them. */
  start(ticketId: string, opts: StartOptions = {}): Promise<void> {
    return this.serial(ticketId, () => this.startNow(ticketId, opts))
  }

  send(ticketId: string, text: string): Promise<void> {
    return this.serial(ticketId, () => this.sendNow(ticketId, text))
  }

  async answer(decisionId: string, a: DecisionAnswer): Promise<void> {
    const { ticketId } = await this.repos.decisions.get(decisionId)
    return this.serial(ticketId, () => this.answerNow(decisionId, a))
  }

  /** Takes effect on an in-flight launch as soon as its process starts; the rest waits its turn. */
  async stop(ticketId: string, expect?: RunExpectation): Promise<void> {
    // A stop for a run that has moved on must not mark the ticket as stopping, or it would kill the next role's launch.
    if (expect) await this.assertExpected(ticketId, expect)
    this.stopRequested.add(ticketId)
    return this.serial(ticketId, () => this.stopNow(ticketId, expect))
  }

  /** The ticket's open run's active role and the one a skip would start; null with no run or an ended one. */
  async activeRole(
    ticketId: string
  ): Promise<{ agentRunId: string; role: string; agentStatus: TicketState['agentStatus']; next: string | null } | null> {
    const { state, run } = await this.inspect(ticketId, false)
    if (!run || run.endReason !== null) return null
    return { agentRunId: run.id, role: run.role, agentStatus: state.agentStatus, next: (await this.nextRole(run))?.name ?? null }
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

  moveToDone(ticketId: string): Promise<'done' | 'dirty'> {
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
  ): Promise<{ state: TicketState; lineup: StripRole[]; skipTo: string | null }> {
    const { state, run, roles } = await this.inspect(ticketId, true)
    if (!run || !roles) {
      const lineup = lineupStrip({ roles: await workspaceLineup(), runs: [], latestRunId: null, agentStatus: null })
      return { state, lineup, skipTo: null }
    }
    const runs = await this.repos.runs.listForTicketRun(run.ticketRunId)
    // The role Skip would start, named in its confirmation.
    const skipTo = run.endReason === null && state.column !== 'done' ? ((await this.nextRole(run))?.name ?? null) : null
    return { state, lineup: lineupStrip({ roles, runs, latestRunId: run.id, agentStatus: state.agentStatus }), skipTo }
  }

  /**
   * The ticket's state, its latest run and that run's ticket-run roles (null with no run). For a Done ticket
   * the run is loaded only when `doneRun` asks for it: Done wins over everything else in its state.
   */
  private async inspect(
    ticketId: string,
    doneRun: boolean
  ): Promise<{ state: TicketState; run: AgentRunRow | null; roles: LineupRole[] | null }> {
    const ticket = await this.repos.tickets.get(ticketId)
    const done = ticket.manualColumn === 'done'
    const run = !done || doneRun ? await this.repos.runs.latest(ticketId) : null
    const roles = run ? (await this.repos.runs.ticketRun(run.ticketRunId)).roles : null
    if (done) {
      // The run's events and the decisions need not be loaded.
      const state = currentState({ ticket, run: null, pendingDecisions: [], processAlive: false, activePhase: 'done' })
      return { state, run, roles }
    }
    const pending = (await this.repos.decisions.pending(ticketId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const activePhase: Phase = run && roles ? roleIn(roles, run).activePhase : 'not_started'
    const state = currentState({
      ticket,
      run: run ? { endReason: run.endReason, events: await this.repos.runs.events(run.id) } : null,
      pendingDecisions: pending,
      processAlive: run ? this.live.has(run.id) || this.isLaunching(ticketId) : false,
      activePhase
    })
    return { state, run, roles }
  }

  /**
   * Called once at launch, before anything starts: no agent process survives a restart in M1.
   * Pending permission decisions can never reach their agent, so they expire; questions stay
   * pending and are delivered when the session is resumed.
   */
  async markAllNotAlive(): Promise<void> {
    const workspace = await this.repos.workspaces.get()
    if (!workspace) return
    for (const ticket of await this.repos.tickets.list(workspace.id)) {
      await this.expirePending({ ticketId: ticket.id, workspaceId: workspace.id }, (d) => d.kind === 'permission')
    }
    this.deps.emit({ type: 'board.changed', workspaceId: workspace.id })
  }

  /**
   * Called when the app quits: lets launches and queued user actions finish (bounded), stops every live
   * agent process and lets its last events land. Nothing launches once it has begun, and a process that
   * finishes starting meanwhile is stopped. The runs stay open (not stopped), so they show as paused
   * and can be continued next launch.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    await settleWithin(Promise.all([...this.chains.values()]).then(() => {}), SHUTDOWN_SETTLE_MS)
    const lives = [...this.live.values()]
    await Promise.all(lives.map((live) => this.stopProcess(live)))
    await settleWithin(Promise.all(lives.map((live) => live.done)).then(() => {}), STOP_DRAIN_MS)
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

  private async startNow(ticketId: string, opts: StartOptions): Promise<void> {
    if (this.shuttingDown) throw new Error(SHUTTING_DOWN)
    if (this.stopRequested.has(ticketId)) return
    const latest = await this.repos.runs.latest(ticketId)
    if (latest && latest.endReason === null) {
      throw new Error('This ticket already has an agent; continue or stop it instead')
    }
    const { workspaceId } = await this.repos.tickets.get(ticketId)
    // Copied into the ticket run, so editing the lineup later never changes this run. Each role's model and
    // effort are resolved now, so every launch of the run uses the same ones.
    const picked = pickRoles(await this.repos.lineups.get(workspaceId), opts?.roleIds)
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
      await this.launch(
        { ...prepared, role: roles[0]!, ticketRunId: created.ticketRunId, handoffs: [], extraInstructions },
        runId,
        prompt,
        answered
      )
    })
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
      await this.record(live, { kind: 'user_message', text })
      const failure = await this.deliver(live, text)
      if (failure !== null) throw new Error(`The message was not delivered: ${failure}`)
      return
    }
    const ticket = await this.repos.tickets.get(ticketId)
    const logged = await this.record(this.target(run, ticket), { kind: 'user_message', text })
    // The message is the prompt, so a fallback digest leaves it out.
    await this.resume(run, text, logged.seq)
  }

  private async answerNow(decisionId: string, a: DecisionAnswer): Promise<void> {
    const decision = await this.repos.decisions.get(decisionId)
    checkAnswer(decision, a)
    const answered = await this.repos.decisions.answer(decisionId, a)
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

  private async stopNow(ticketId: string, expect?: RunExpectation): Promise<void> {
    // Everything queued before this stop has finished; later actions are not affected.
    this.stopRequested.delete(ticketId)
    this.limited.delete(ticketId)
    const run = await this.repos.runs.latest(ticketId)
    if (!run) return
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
    // Only Resume ends the user's own pause: unattended mode continues a usage-limit pause through here.
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
    this.limited.delete(ticketId)
    const ticket = await this.repos.tickets.get(ticketId)
    // Recorded before the process goes, so the ticket shows Paused at once.
    await this.record(this.target(run, ticket), { kind: 'paused' })
    // The run stays open with its session, as after a restart: Resume continues it by session id.
    await this.halt(live)
    this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
  }

  private async resumeNow(ticketId: string): Promise<void> {
    if (this.shuttingDown) throw new Error(SHUTTING_DOWN)
    const run = await this.repos.runs.latest(ticketId)
    if (!run || run.endReason !== null || !pausedByUser(await this.repos.runs.events(run.id))) throw new Error(NOTHING_PAUSED)
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
      this.limited.delete(ticketId)
      // A handed-off role's process may still be ending its last turn; it is stopped along with the active one.
      for (const live of [...this.live.values()].filter((l) => l.ticketId === ticketId)) await this.halt(live)
      this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })

      const { summary, source } = await this.skipSummary(run, next)
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
      this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
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
   * The handoff summary of a skipped role: written by a one-shot model call, through the runtime and the user's own
   * `claude`, from the role's log in this ticket run; or, when that fails, is empty or takes too long, the digest.
   */
  private async skipSummary(run: AgentRunRow, next: LineupRole | null): Promise<{ summary: string; source: 'summary' | 'digest' }> {
    const events: StoredEvent[] = []
    for (const earlier of await this.repos.runs.listForTicketRun(run.ticketRunId)) {
      if (earlier.roleId === run.roleId) events.push(...(await this.repos.runs.events(earlier.id)))
      if (earlier.id === run.id) break
    }
    const decisions = await this.repos.decisions.forTicket(run.ticketId)
    try {
      const { worktree } = await this.prepare(run.ticketId)
      const timeoutMs = this.deps.summaryTimeoutMs ?? SKIP_SUMMARY_MS
      const call = this.deps.runtime.summarize({
        cwd: worktree.path,
        tempDir: worktree.scratch,
        prompt: skipSummaryPrompt(events, decisions, run.role, next?.name ?? null),
        timeoutMs
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

  private async moveToDoneNow(ticketId: string): Promise<'done' | 'dirty'> {
    const ticket = await this.repos.tickets.get(ticketId)
    const where = { ticketId, workspaceId: ticket.workspaceId }
    const run = await this.repos.runs.latest(ticketId)
    const live = run ? this.live.get(run.id) : undefined
    if (live && !live.ended) throw new Error('The agent is still working on this ticket; stop it first')
    // A handed-off agent may not have ended its last turn yet.
    if (live) await this.stopProcess(live)

    // Removal first: on 'dirty' a paused run must stay paused, so its session can still be continued.
    // Nothing can revive the agent in between, because this step holds the ticket's queue.
    if (ticket.worktreePath !== null && ticket.branch !== null) {
      const workspace = await this.workspaceOf(ticket)
      const outcome = await this.deps.worktrees.remove(ticket.id, workspace.repoPath, ticket.worktreePath, ticket.branch, {
        discard: false
      })
      if (outcome === 'dirty') return 'dirty'
      await this.repos.tickets.setWorktree(ticket.id, ticket.branch, null)
    }
    if (run && run.endReason === null) {
      // A paused run ends here, so nothing can revive an agent on a Done ticket.
      if (await this.repos.runs.end(run.id, 'stopped')) await this.record(this.target(run, ticket), { kind: 'stopped' })
    }
    await this.repos.tickets.setManualColumn(ticket.id, 'done')
    this.limited.delete(ticket.id)
    await this.expirePending(where, () => true)
    this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
    return 'done'
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

  // --- launching (always inside a queued step) ---

  private async prepare(ticketId: string): Promise<Prepared> {
    let ticket = await this.repos.tickets.get(ticketId)
    const workspace = await this.workspaceOf(ticket)
    const worktree = await this.deps.worktrees.ensure(workspace, ticket)
    ticket = await this.repos.tickets.setWorktree(ticket.id, worktree.branch, worktree.path)
    return { ticket, workspace, worktree }
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
    }
  }

  /**
   * Resumes the run's session with `prompt`; if that fails, starts a fresh agent with a digest of the
   * thread (events from seq `digestBefore` on are left out of the digest), including the role's earlier
   * runs in this ticket run. A role that was handed the ticket but never launched gets a fresh session with
   * its first message instead.
   */
  private async resume(run: AgentRunRow, prompt: string, digestBefore?: number): Promise<void> {
    if (this.shuttingDown) return
    const current = await this.repos.runs.latest(run.ticketId)
    if (!current || current.id !== run.id || current.endReason !== null || this.live.has(run.id)) return
    await this.whileLaunching(run.ticketId, async () => {
      const prepared = await this.prepare(run.ticketId)
      const ticketRun = await this.repos.runs.ticketRun(current.ticketRunId)
      const launch: Launch = {
        ...prepared,
        role: roleIn(ticketRun.roles, current),
        ticketRunId: current.ticketRunId,
        handoffs: await this.handoffsBefore(current),
        extraInstructions: ticketRun.extraInstructions
      }
      const events = await this.repos.runs.events(run.id)
      // A role handed a problem back, or returned to, worked in its earlier runs of this ticket run too.
      const before: StoredEvent[] = []
      for (const earlier of await this.repos.runs.listForTicketRun(current.ticketRunId)) {
        if (earlier.id === current.id) break
        if (earlier.roleId === current.roleId) before.push(...(await this.repos.runs.events(earlier.id)))
      }
      // The whole ticket's decisions, so a run made by Start again keeps the earlier runs' answers.
      const decisions = await this.repos.decisions.forTicket(run.ticketId)
      if (pausedByUser(events)) {
        // Whatever resumes it (Resume, a message, an answer), the user's pause is over.
        if (this.stopRequested.has(run.ticketId) || this.shuttingDown) return
        await this.record(this.target(current, launch.ticket), { kind: 'resumed' })
      }
      const neverLaunched = [...before, ...events].every((e) => NOT_LAUNCHED_KINDS.has(e.event.kind))
      if (current.sessionId === null && neverLaunched) {
        const handedBy = events.find((e) => e.event.kind === 'role_handoff')?.event
        const first = firstMessage(launch.ticket, handedBy?.kind === 'role_handoff' ? handedBy.from : undefined)
        const bare = prompt === CONTINUE_TEXT || prompt === RESUME_TEXT
        await this.launch(launch, run.id, bare ? first : `${first}\n\n${prompt}`, decisions)
        return
      }
      if (current.sessionId !== null) {
        try {
          await this.launch(launch, run.id, prompt, decisions, current.sessionId)
          return
        } catch (err) {
          if (!(err instanceof ResumeFailedError)) throw err
        }
      }
      // launch() checks stopRequested first, so a stop queued meanwhile prevents the fresh agent.
      const own = digestBefore === undefined ? events : events.filter((e) => e.seq < digestBefore)
      const digest = previousAttempt([...before, ...own], decisions, launch.role.name)
      await this.launch(launch, run.id, `${digest}\n\n${prompt}`, decisions)
    })
  }

  /**
   * Marks the ticket as launching for the whole of `fn` (worktree setup included), so stateOf shows it working.
   * The board changes once more when it ends, so a launch that failed before its process started is seen too.
   */
  private async whileLaunching(ticketId: string, fn: () => Promise<void>): Promise<void> {
    this.limited.delete(ticketId)
    this.launching.add(ticketId)
    try {
      await fn()
    } finally {
      this.launching.delete(ticketId)
      const ticket = await this.repos.tickets.get(ticketId).catch(() => null)
      if (ticket) this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
    }
  }

  private async launch(
    launch: Launch,
    runId: string,
    prompt: string,
    decisions: Decision[],
    resumeSessionId?: string
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
    // Ticket runs started before models were resolved at start hold nulls: those get the default table.
    const fallback = defaultFor(role.name)
    const spec: RunSpec = {
      role: role.name,
      cwd: worktree.path,
      tempDir: worktree.scratch,
      ownBranch: worktree.branch,
      prompt,
      appendSystemPrompt: buildRolePrompt(role, ticket, decisions, launch.handoffs, launch.extraInstructions),
      model: role.model ?? fallback.model,
      effort: role.effort ?? fallback.effort,
      toolProfile: role.toolProfile,
      disallowedTools: DISALLOWED_TOOLS,
      // Edits and simple file commands in the scratch folder run without asking, as in the worktree.
      additionalDirectories: [worktree.scratch],
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
      roleTools: this.roleTools(target, worktree.path),
      onPermission: (req) => this.onPermission(target, worktree, req)
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
      const live: LiveRun = {
        ...target,
        handle,
        silentTurns: 0,
        errorTurns: 0,
        askedThisTurn: false,
        ended: false,
        stopping: null,
        limit: null,
        done: Promise.resolve()
      }
      this.live.set(runId, live)
      live.done = this.pump(live)
    } finally {
      this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
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
      if (isUsageLimitText(errorText(err))) live.limit ??= { resetsAt: null }
      await this.record(live, { kind: 'error', message: errorText(err) }).catch(() => {})
    }
    // The process ended over a usage limit with the run still open: the run is paused until the limit resets.
    if (!live.ended && live.limit !== null && !this.shuttingDown && this.unattended()) this.limited.set(live.ticketId, live.limit)
    try {
      if (!live.ended) await this.record(live, { kind: 'process_exit', code: null })
      // A permission answer can no longer reach this process.
      await this.expirePending(live, (d) => d.kind === 'permission' && d.agentRunId === live.runId)
    } catch {
      // The database is gone (shutdown); there is nothing left to record.
    }
    this.live.delete(live.runId)
    this.deps.emit({ type: 'board.changed', workspaceId: live.workspaceId })
  }

  private async onEvent(live: LiveRun, event: AgentEvent): Promise<void> {
    if ((event.kind === 'message' || event.kind === 'thinking') && event.partial) {
      // Streaming previews are shown but never stored; the final event follows.
      const preview: StoredEvent = { runId: live.runId, seq: 0, at: this.deps.now().toISOString(), event }
      this.deps.emit({ type: 'thread.appended', ticketId: live.ticketId, event: preview, run: threadRun(live) })
      return
    }
    if (event.kind === 'session') await this.repos.runs.setSession(live.runId, event.sessionId)
    if (event.kind === 'rate_limit') live.limit = limitFromEvent(event)
    if (event.kind === 'error' && isUsageLimitText(event.message)) live.limit ??= { resetsAt: null }
    await this.record(live, event)
    if (event.kind === 'turn_end') await this.onTurnEnd(live, event)
  }

  private async onTurnEnd(live: LiveRun, event: Extract<AgentEvent, { kind: 'turn_end' }>): Promise<void> {
    // The agent is going down with the app: no nudge, no failure.
    if (this.shuttingDown) return
    if (live.ended) {
      // Handed off (or failed or stopped): the agent's last turn is over, so its process can go.
      void this.stopProcess(live)
      return
    }
    const asked = live.askedThisTurn
    live.askedThisTurn = false
    // Mainbus's own interrupt is not the agent going quiet.
    if (event.interrupted) return
    if (!event.ok && isUsageLimitText(event.error)) live.limit ??= { resetsAt: null }
    if (!event.ok && live.limit !== null && this.unattended()) {
      // A usage limit is not a failure: stop the process and keep the run open, so it can be continued once
      // the limit resets. The pump marks the ticket as paused by the limit when the process has gone.
      await this.record(live, { kind: 'notice', text: USAGE_LIMIT_PAUSE })
      void this.stopProcess(live)
      return
    }
    if (event.ok) live.limit = null
    if (!event.ok) {
      // An error (the API failing, say) is not the agent going quiet either; twice in a row fails the run.
      live.errorTurns++
      if (live.errorTurns >= 2) await this.fail(live, event.error ?? 'The agent turn failed')
      return
    }
    live.errorTurns = 0
    if (asked || (await this.repos.decisions.pending(live.ticketId)).length > 0) {
      live.silentTurns = 0
      return
    }
    live.silentTurns++
    if (live.silentTurns >= 2) {
      await this.fail(live, SILENT_FAILURE)
      return
    }
    await this.record(live, { kind: 'nudge', text: NUDGE_TEXT })
    const failure = await this.deliver(live, NUDGE_TEXT)
    if (failure !== null) await this.record(live, { kind: 'error', message: `Mainbus could not send the nudge: ${failure}` })
  }

  /** Ends the run as failed, unless something else ended it first; `message` becomes the card's summary. */
  private async fail(live: LiveRun, message: string): Promise<void> {
    if (!(await this.repos.runs.end(live.runId, 'failed'))) return
    live.ended = true
    await this.record(live, { kind: 'error', message })
    void this.stopProcess(live)
  }

  /** Sends to a live agent. Returns null once delivered, or why it was not. */
  private async deliver(live: LiveRun, text: string): Promise<string | null> {
    if (live.ended || live.stopping) return 'the agent has stopped'
    try {
      await this.deps.runtime.send(live.handle, text)
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

  private roleTools(target: ThreadTarget, worktreePath: string): RoleToolHandlers {
    return {
      askUser: async ({ question, options, recommended }) => {
        if (options.length === 0) return 'Not asked: give the user at least one option to choose from.'
        const valid = recommended !== undefined && Number.isInteger(recommended) && recommended >= 0 && recommended < options.length
        return this.ask(target, question, options, valid ? recommended : null)
      },

      handoff: async ({ summary, notesForNext }) => {
        const run = await this.repos.runs.latest(target.ticketId)
        if (!run || run.id !== target.runId || run.endReason !== null) return RUN_ENDED
        if (await this.deps.worktrees.hasUncommitted(worktreePath)) return COMMIT_FIRST
        const next = await this.nextRole(run)
        let nextRun: AgentRunRow | null = null
        if (next) {
          // The ticket counts as working from before the next role's run exists until its launch is over,
          // so it never shows in Review between roles.
          const wasHandingOn = this.handingOn.has(target.ticketId)
          this.handingOn.add(target.ticketId)
          nextRun = await this.repos.runs.handOn(target.runId, next)
          if (nextRun === null) {
            if (!wasHandingOn) this.handingOn.delete(target.ticketId)
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
          void this.serial(target.ticketId, () => this.publishNow(target.ticketId, false)).catch(() => {})
        }
        return HANDED_OFF
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
    const back = await this.repos.runs.handBack(target.runId, to, from.id)
    if (back === null) {
      if (!wasHandingOn) this.handingOn.delete(target.ticketId)
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
    // The same folders as the run's, so the guard and allow rules treat the scratch folder as inside.
    const folders = { worktree: worktree.path, additionalDirectories: [worktree.scratch], scratch: worktree.scratch }
    const guard = guardReason(req.toolName, req.input, { ...folders, ownBranch: worktree.branch })
    const guarded = guard !== null
    const shell = isShellTool(req.toolName)
    const command = shell ? commandOf(req.input) : null
    const forcePush = command !== null && isDestructivePush(command)
    // Reading or printing credentials asks every time: no rule, not even an exact one, covers it.
    const secret = credentialReason(req.toolName, req.input) !== null
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
    if (this.unattended() && guard?.kind !== 'hard_stop' && !forcePush && !secret) {
      await this.record(target, { kind: 'notice', text: `${AUTO_ALLOWED}: ${describeRequest(req, target.role)}` })
      return { allow: true }
    }

    const decision = await this.repos.decisions.open({
      ticketId: target.ticketId,
      agentRunId: target.runId,
      kind: 'permission',
      // The guard's reason tells the user why Mainbus is asking.
      question: describeRequest(req, target.role) + (req.reason ? ` — ${req.reason}` : ''),
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
    for (const d of await this.repos.decisions.pending(where.ticketId)) {
      if (which(d)) await this.expireIfPending(d.id, where.workspaceId)
    }
  }

  /** Expires the decision if it is still pending, and releases any agent waiting on it with no answer. */
  private async expireIfPending(decisionId: string, workspaceId: string): Promise<void> {
    if ((await this.repos.decisions.get(decisionId)).status === 'pending') {
      // expire() throws if someone settled it in the meantime; then there is nothing to do.
      const expired = await this.repos.decisions.expire(decisionId).catch(() => null)
      if (expired) this.announceDecision(expired, workspaceId)
    }
    this.waiters.get(decisionId)?.(null)
  }

  private announceDecision(decision: Decision, workspaceId: string): void {
    this.deps.emit({ type: 'decision.changed', decision })
    this.deps.emit({ type: 'board.changed', workspaceId })
  }

  // --- helpers ---

  private async record(target: ThreadTarget, event: ThreadEvent): Promise<StoredEvent> {
    const stored = await this.repos.runs.append(target.runId, event)
    this.deps.emit({ type: 'thread.appended', ticketId: target.ticketId, event: stored, run: threadRun(target) })
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
    const workspace = await this.repos.workspaces.get()
    if (!workspace || workspace.id !== ticket.workspaceId) throw new Error(`No workspace for ticket ${ticket.id}`)
    return workspace
  }
}

/** The run's role in its ticket run's snapshot `roles`. */
function roleIn(roles: LineupRole[], run: AgentRunRow): LineupRole {
  const role = roles.find((r) => r.id === run.roleId)
  if (!role) throw new Error(`The role of run ${run.id} is missing from its ticket run`)
  return role
}

/** The run a thread event of `target` belongs to, as the renderer sees it. */
function threadRun(target: ThreadTarget): ThreadRun {
  return { id: target.runId, ticketRunId: target.ticketRunId, role: target.role }
}

/** What a role's thread can hold before its agent was ever launched: the handoff to it, and messages for it. */
const NOT_LAUNCHED_KINDS = new Set<ThreadEvent['kind']>(['role_handoff', 'role_hand_back', 'user_message', 'paused', 'resumed'])

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
async function withinMs<T>(p: Promise<T>, ms: number): Promise<T> {
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
