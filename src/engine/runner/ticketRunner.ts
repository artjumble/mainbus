import type { EngineEvent } from '../../shared/api'
import type {
  Decision,
  DecisionAnswer,
  LineupRole,
  Phase,
  StartOptions,
  Ticket,
  TicketState,
  Workspace
} from '../../shared/domain'
import type { AgentEvent, StoredEvent, ThreadEvent } from '../../shared/events'
import type { PublishInput, PublishResult } from '../git/pullRequests'
import type { WorktreeManager } from '../git/worktrees'
import { credentialReason } from '../permissions/credentials'
import { guardReason } from '../permissions/guard'
import { commandOf, describeRequest, isAllowed, isDestructivePush, isShellTool, rulesFromRequest } from '../permissions/policy'
import { parseShell } from '../permissions/shell'
import { DISALLOWED_TOOLS } from '../roles/hardening'
import { buildRolePrompt, firstMessage, type EarlierHandoff } from '../roles/prompt'
import {
  ResumeFailedError,
  type AgentRuntime,
  type PermissionRequest,
  type PermissionVerdict,
  type RoleToolHandlers,
  type RunHandle,
  type RunSpec
} from '../runtime/types'
import { currentState } from '../state/currentState'
import type { Repos } from '../store'
import type { AgentRunRow } from '../store/runs'
import { previousAttempt } from './digest'
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
}

export const NUDGE_TEXT =
  'You ended your turn without asking the user or handing off. If you are done, commit and call mcp__mainbus__handoff. If you need the user, call mcp__mainbus__ask_user. Otherwise continue.'
const CONTINUE_TEXT = 'Continue where you left off.'
const ASK_RECORDED = 'Recorded. End your turn now; the answer will arrive as your next message.'
const HANDED_OFF = 'Handed off. Your part is done; end your turn now.'
const COMMIT_FIRST =
  'Not handed off: the worktree has uncommitted changes. Commit all your work on the current branch, then call mcp__mainbus__handoff again.'
const RUN_ENDED = 'This run has ended.'
const NOT_WORKING = 'No agent is working on this ticket'
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

/** Where a thread event goes: the run's thread, announced for its ticket and workspace. */
interface ThreadTarget {
  runId: string
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
  worktree: { branch: string; path: string }
}

interface Launch extends Prepared {
  role: LineupRole
  /** What the earlier roles of the run's ticket run said when they handed off. */
  handoffs: EarlierHandoff[]
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
  stop(ticketId: string): Promise<void> {
    this.stopRequested.add(ticketId)
    return this.serial(ticketId, () => this.stopNow(ticketId))
  }

  continue(ticketId: string): Promise<void> {
    return this.serial(ticketId, () => this.continueNow(ticketId))
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
    const ticket = await this.repos.tickets.get(ticketId)
    if (ticket.manualColumn === 'done') {
      // Done wins over everything else, so the runs and their events need not be loaded.
      return currentState({ ticket, run: null, pendingDecisions: [], processAlive: false, activePhase: 'done' })
    }
    const run = await this.repos.runs.latest(ticketId)
    const pending = (await this.repos.decisions.pending(ticketId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const activePhase: Phase = run ? (await this.roleOf(run)).activePhase : 'not_started'
    return currentState({
      ticket,
      run: run ? { endReason: run.endReason, events: await this.repos.runs.events(run.id) } : null,
      pendingDecisions: pending,
      processAlive: run ? this.live.has(run.id) || this.isLaunching(ticketId) : false,
      activePhase
    })
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
    // Copied into the ticket run, so editing the lineup later never changes this run.
    const roles = pickRoles(await this.repos.lineups.get(workspaceId), opts?.roleIds)
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
      const runId = await this.repos.runs.create(ticketId, roles)
      await this.launch({ ...prepared, role: roles[0]!, handoffs: [] }, runId, prompt, answered)
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
    const text = answerText(decision, a as Extract<DecisionAnswer, { kind: 'option' }>)
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

  private async stopNow(ticketId: string): Promise<void> {
    // Everything queued before this stop has finished; later actions are not affected.
    this.stopRequested.delete(ticketId)
    this.limited.delete(ticketId)
    const run = await this.repos.runs.latest(ticketId)
    if (!run) return
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
    await this.resume(run, CONTINUE_TEXT)
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
    const result = await publisher.publish({
      ticket: { ...ticket, branch, worktreePath },
      baseBranch: workspace.baseBranch,
      handoffSummary: handoff?.kind === 'handoff' ? handoff.summary : null
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

  /** The run's role, from its ticket run's snapshot. */
  private async roleOf(run: AgentRunRow): Promise<LineupRole> {
    const { roles } = await this.repos.runs.ticketRun(run.ticketRunId)
    const role = roles.find((r) => r.id === run.roleId)
    if (!role) throw new Error(`The role of run ${run.id} is missing from its ticket run`)
    return role
  }

  /** The role after the run's own in its ticket run, or null when the run's role is the last. */
  private async nextRole(run: AgentRunRow): Promise<LineupRole | null> {
    const { roles } = await this.repos.runs.ticketRun(run.ticketRunId)
    const i = roles.findIndex((r) => r.id === run.roleId)
    return i >= 0 ? (roles[i + 1] ?? null) : null
  }

  /** The handoffs of the roles before `run` in its ticket run, in order. */
  private async handoffsBefore(run: AgentRunRow): Promise<EarlierHandoff[]> {
    const handoffs: EarlierHandoff[] = []
    for (const earlier of await this.repos.runs.listForTicketRun(run.ticketRunId)) {
      if (earlier.id === run.id) break
      if (earlier.endReason !== 'handoff') continue
      const event = (await this.repos.runs.events(earlier.id)).findLast((e) => e.event.kind === 'handoff')?.event
      if (event?.kind !== 'handoff') continue
      handoffs.push({
        role: earlier.role,
        summary: event.summary,
        ...(event.notesForNext !== undefined ? { notesForNext: event.notesForNext } : {})
      })
    }
    return handoffs
  }

  /** Launches the role a handoff just started; the ticket counts as launching until this is over. */
  private async handOnNow(run: AgentRunRow): Promise<void> {
    try {
      await this.resume(run, CONTINUE_TEXT)
    } finally {
      this.handingOn.delete(run.ticketId)
    }
  }

  /**
   * Resumes the run's session with `prompt`; if that fails, starts a fresh agent with a digest of the
   * thread (events from seq `digestBefore` on are left out of the digest). A role that was handed the
   * ticket but never launched gets a fresh session with its first message instead.
   */
  private async resume(run: AgentRunRow, prompt: string, digestBefore?: number): Promise<void> {
    if (this.shuttingDown) return
    const current = await this.repos.runs.latest(run.ticketId)
    if (!current || current.id !== run.id || current.endReason !== null || this.live.has(run.id)) return
    await this.whileLaunching(run.ticketId, async () => {
      const prepared = await this.prepare(run.ticketId)
      const role = await this.roleOf(current)
      const launch: Launch = { ...prepared, role, handoffs: await this.handoffsBefore(current) }
      const events = await this.repos.runs.events(run.id)
      // The whole ticket's decisions, so a run made by Start again keeps the earlier runs' answers.
      const decisions = await this.repos.decisions.forTicket(run.ticketId)
      if (current.sessionId === null && events.every((e) => NOT_LAUNCHED_KINDS.has(e.event.kind))) {
        const handedBy = events.find((e) => e.event.kind === 'role_handoff')?.event
        const first = firstMessage(launch.ticket, handedBy?.kind === 'role_handoff' ? handedBy.from : undefined)
        await this.launch(launch, run.id, prompt === CONTINUE_TEXT ? first : `${first}\n\n${prompt}`, decisions)
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
      const earlier = digestBefore === undefined ? events : events.filter((e) => e.seq < digestBefore)
      const digest = previousAttempt(earlier, decisions, launch.role.name)
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
    const target: ThreadTarget = { runId, ticketId: ticket.id, workspaceId: ticket.workspaceId, role: role.name }
    const spec: RunSpec = {
      role: role.name,
      cwd: worktree.path,
      ownBranch: worktree.branch,
      prompt,
      appendSystemPrompt: buildRolePrompt(role, ticket, decisions, launch.handoffs),
      ...(role.model !== null ? { model: role.model } : {}),
      ...(role.effort !== null ? { effort: role.effort } : {}),
      toolProfile: role.toolProfile,
      disallowedTools: DISALLOWED_TOOLS,
      additionalDirectories: [],
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
      this.deps.emit({ type: 'thread.appended', ticketId: live.ticketId, event: preview })
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
        const live = this.live.get(target.runId)
        if (live) live.askedThisTurn = true
        if (!(await this.isOpen(target))) return RUN_ENDED
        const decision = await this.repos.decisions.open({
          ticketId: target.ticketId,
          agentRunId: target.runId,
          kind: 'question',
          question,
          options,
          recommended:
            recommended !== undefined && Number.isInteger(recommended) && recommended >= 0 && recommended < options.length
              ? recommended
              : null,
          allowAlways: false
        })
        if (!(await this.isOpen(target))) {
          await this.expireIfPending(decision.id, target.workspaceId)
          return RUN_ENDED
        }
        await this.record(target, { kind: 'decision', decisionId: decision.id })
        this.announceDecision(decision, target.workspaceId)
        return ASK_RECORDED
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
          const nextRunId = await this.repos.runs.handOn(target.runId, next)
          if (nextRunId === null) {
            if (!wasHandingOn) this.handingOn.delete(target.ticketId)
            return RUN_ENDED
          }
          nextRun = { ...run, id: nextRunId, roleId: next.id, role: next.name, sessionId: null, endReason: null, endedAt: null }
        } else if (!(await this.repos.runs.end(target.runId, 'handoff'))) {
          return RUN_ENDED
        }
        const live = this.live.get(target.runId)
        if (live) live.ended = true
        await this.record(target, { kind: 'handoff', summary, outcome: 'done', notesForNext })
        // Nobody is left to receive an answer to this run's open questions.
        await this.expirePending(target, (d) => d.kind === 'question' && d.agentRunId === target.runId)
        if (nextRun) {
          const handedTo = nextRun
          const ticket = await this.repos.tickets.get(target.ticketId)
          await this.record(this.target(handedTo, ticket), { kind: 'role_handoff', from: target.role, to: handedTo.role })
          // The next role starts in the ticket's queue, without holding up this reply. Only the last role's
          // handoff pushes.
          void this.serial(target.ticketId, () => this.handOnNow(handedTo)).catch(() => {})
        } else {
          // The ticket is in Review now; the push and PR follow in its queue, without holding up this reply.
          void this.serial(target.ticketId, () => this.publishNow(target.ticketId, false)).catch(() => {})
        }
        return HANDED_OFF
      }
    }
  }

  // --- permissions ---

  private async onPermission(
    target: ThreadTarget,
    worktree: { branch: string; path: string },
    req: PermissionRequest
  ): Promise<PermissionVerdict> {
    if (!(await this.isOpen(target))) return { allow: false, message: RUN_ENDED }
    const folders = { worktree: worktree.path, additionalDirectories: [] }
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
    this.deps.emit({ type: 'thread.appended', ticketId: target.ticketId, event: stored })
    this.deps.emit({ type: 'board.changed', workspaceId: target.workspaceId })
    return stored
  }

  /** True while the target run is its ticket's latest run and has not ended. */
  private async isOpen(target: ThreadTarget): Promise<boolean> {
    const run = await this.repos.runs.latest(target.ticketId)
    return run !== null && run.id === target.runId && run.endReason === null
  }

  private target(run: AgentRunRow, ticket: Ticket): ThreadTarget {
    return { runId: run.id, ticketId: ticket.id, workspaceId: ticket.workspaceId, role: run.role }
  }

  private async workspaceOf(ticket: Ticket): Promise<Workspace> {
    const workspace = await this.repos.workspaces.get()
    if (!workspace || workspace.id !== ticket.workspaceId) throw new Error(`No workspace for ticket ${ticket.id}`)
    return workspace
  }
}

/** What a role's thread can hold before its agent was ever launched: the handoff to it, and messages for it. */
const NOT_LAUNCHED_KINDS = new Set<ThreadEvent['kind']>(['role_handoff', 'user_message'])

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

/** Waits for `p`, but no longer than `ms`. */
async function settleWithin(p: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const gaveUp = new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))
  await Promise.race([p, gaveUp])
  clearTimeout(timer)
}
