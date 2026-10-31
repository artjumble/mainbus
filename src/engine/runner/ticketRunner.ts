import type { EngineEvent } from '../../shared/api'
import type { Decision, DecisionAnswer, Role, Ticket, TicketState, Workspace } from '../../shared/domain'
import type { AgentEvent, StoredEvent, ThreadEvent } from '../../shared/events'
import type { WorktreeManager } from '../git/worktrees'
import { guardReason } from '../permissions/guard'
import { commandOf, describeRequest, isAllowed, isDestructivePush, isShellTool, ruleFromRequest } from '../permissions/policy'
import { parseShell } from '../permissions/shell'
import { DISALLOWED_TOOLS } from '../roles/hardening'
import { buildRolePrompt, firstMessage } from '../roles/prompt'
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

export interface RunnerDeps {
  repos: Repos
  worktrees: WorktreeManager
  runtime: AgentRuntime
  now: () => Date
  emit: (e: EngineEvent) => void
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

/** Where a thread event goes: the run's thread, announced for its ticket and workspace. */
interface ThreadTarget {
  runId: string
  ticketId: string
  workspaceId: string
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
  /** Settles when the event pump has finished. */
  done: Promise<void>
}

interface Launch {
  ticket: Ticket
  workspace: Workspace
  role: Role
  worktree: { branch: string; path: string }
}

type PermissionWaiter = (a: DecisionAnswer | null) => void

/**
 * Drives one Implementer agent per ticket: starts and resumes it, records its thread, and turns its asks
 * into decisions. User actions on a ticket run one at a time, in order; agent callbacks are not queued,
 * and every run ending goes through the conditional `runs.end`, so the first ending wins.
 */
export class TicketRunner {
  private readonly repos: Repos
  private readonly live = new Map<string, LiveRun>()
  /** The tail of each ticket's queue of user actions. */
  private readonly chains = new Map<string, Promise<void>>()
  /** Tickets being launched right now (worktree setup and process start). */
  private readonly launching = new Set<string>()
  /** Tickets with a stop on the way: launches skip or immediately stop their process. */
  private readonly stopRequested = new Set<string>()
  /** Set by shutdown(): nothing new launches, and a process that finishes starting is stopped at once. */
  private shuttingDown = false
  /** Permission decisions an agent is waiting on, by decision id. */
  private readonly waiters = new Map<string, PermissionWaiter>()

  constructor(private readonly deps: RunnerDeps) {
    this.repos = deps.repos
  }

  start(ticketId: string): Promise<void> {
    return this.serial(ticketId, () => this.startNow(ticketId))
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

  moveToDone(ticketId: string): Promise<'done' | 'dirty'> {
    return this.serial(ticketId, () => this.moveToDoneNow(ticketId))
  }

  /** Moves a ticket to Backlog or Ready in its turn, so it can't slip in between `start` and the run it creates. */
  moveToColumn(ticketId: string, column: 'backlog' | 'ready'): Promise<void> {
    return this.serial(ticketId, () => this.moveToColumnNow(ticketId, column))
  }

  async stateOf(ticketId: string): Promise<TicketState> {
    const ticket = await this.repos.tickets.get(ticketId)
    const role = await this.repos.roles.get(ticket.workspaceId)
    if (ticket.manualColumn === 'done') {
      // Done wins over everything else, so the runs and their events need not be loaded.
      return currentState({ ticket, run: null, pendingDecisions: [], processAlive: false, activePhase: role.activePhase })
    }
    const run = await this.repos.runs.latest(ticketId)
    const pending = (await this.repos.decisions.pending(ticketId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return currentState({
      ticket,
      run: run ? { endReason: run.endReason, events: await this.repos.runs.events(run.id) } : null,
      pendingDecisions: pending,
      processAlive: run ? this.live.has(run.id) || this.launching.has(ticketId) : false,
      activePhase: role.activePhase
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

  private async startNow(ticketId: string): Promise<void> {
    if (this.shuttingDown) throw new Error(SHUTTING_DOWN)
    if (this.stopRequested.has(ticketId)) return
    const latest = await this.repos.runs.latest(ticketId)
    if (latest && latest.endReason === null) {
      throw new Error('This ticket already has an agent; continue or stop it instead')
    }
    await this.whileLaunching(ticketId, async () => {
      const launch = await this.prepare(ticketId)
      if (this.stopRequested.has(ticketId) || this.shuttingDown) return
      let prompt = firstMessage(launch.ticket)
      let answered: Decision[] = []
      if (latest) {
        // Start again: the new agent learns what the earlier run did and what the user decided.
        const decisions = await this.repos.decisions.forTicket(ticketId)
        const digest = previousAttempt(await this.repos.runs.events(latest.id), decisions, launch.role.name)
        prompt = `${digest}\n\n${prompt}`
        answered = decisions.filter((d) => d.status === 'answered')
      }
      const runId = await this.repos.runs.create(ticketId, launch.role.name, launch.role.model, launch.role.effort)
      await this.launch(launch, runId, prompt, answered)
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
    const run = await this.repos.runs.latest(ticketId)
    if (!run) return
    const ticket = await this.repos.tickets.get(ticketId)
    const target = this.target(run, ticket)
    const live = this.live.get(run.id)
    if (live) {
      // Stop the process first and let its last events land, so nothing is recorded after `stopped`.
      live.ended = true
      await this.stopProcess(live)
      await settleWithin(live.done, STOP_DRAIN_MS)
    }
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
    await this.expirePending(where, () => true)
    this.deps.emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
    return 'done'
  }

  // --- launching (always inside a queued step) ---

  private async prepare(ticketId: string): Promise<Launch> {
    let ticket = await this.repos.tickets.get(ticketId)
    const workspace = await this.workspaceOf(ticket)
    const role = await this.repos.roles.get(workspace.id)
    const worktree = await this.deps.worktrees.ensure(workspace, ticket)
    ticket = await this.repos.tickets.setWorktree(ticket.id, worktree.branch, worktree.path)
    return { ticket, workspace, role, worktree }
  }

  /**
   * Resumes the run's session with `prompt`; if that fails, starts a fresh agent with a digest of the
   * thread (events from seq `digestBefore` on are left out of the digest).
   */
  private async resume(run: AgentRunRow, prompt: string, digestBefore?: number): Promise<void> {
    if (this.shuttingDown) return
    const current = await this.repos.runs.latest(run.ticketId)
    if (!current || current.id !== run.id || current.endReason !== null || this.live.has(run.id)) return
    await this.whileLaunching(run.ticketId, async () => {
      const launch = await this.prepare(run.ticketId)
      const events = await this.repos.runs.events(run.id)
      // The whole ticket's decisions, so a run made by Start again keeps the earlier runs' answers.
      const decisions = await this.repos.decisions.forTicket(run.ticketId)
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

  /** Marks the ticket as launching for the whole of `fn` (worktree setup included), so stateOf shows it working. */
  private async whileLaunching(ticketId: string, fn: () => Promise<void>): Promise<void> {
    this.launching.add(ticketId)
    try {
      await fn()
    } finally {
      this.launching.delete(ticketId)
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
    const target: ThreadTarget = { runId, ticketId: ticket.id, workspaceId: ticket.workspaceId }
    const spec: RunSpec = {
      cwd: worktree.path,
      ownBranch: worktree.branch,
      prompt,
      appendSystemPrompt: buildRolePrompt(role, ticket, decisions),
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
      await this.record(live, { kind: 'error', message: errorText(err) }).catch(() => {})
    }
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

      handoff: async ({ summary }) => {
        if (!(await this.isOpen(target))) return RUN_ENDED
        if (await this.deps.worktrees.hasUncommitted(worktreePath)) return COMMIT_FIRST
        if (!(await this.repos.runs.end(target.runId, 'handoff'))) return RUN_ENDED
        const live = this.live.get(target.runId)
        if (live) live.ended = true
        await this.record(target, { kind: 'handoff', summary, outcome: 'done' })
        // Nobody is left to receive an answer to this run's open questions.
        await this.expirePending(target, (d) => d.kind === 'question' && d.agentRunId === target.runId)
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
    const guarded =
      guardReason(req.toolName, req.input, { worktree: worktree.path, additionalDirectories: [], ownBranch: worktree.branch }) !==
      null
    const shell = isShellTool(req.toolName)
    const command = shell ? commandOf(req.input) : null
    const forcePush = command !== null && isDestructivePush(command)
    // "Always allow" would be a lie where no rule can allow the request: a force-push, an unparseable
    // command, or a guarded non-shell request (its rule would cover the tool everywhere, not this path).
    const noAlways = (command !== null && (forcePush || parseShell(command).opaque)) || (guarded && !shell)

    if (!forcePush) {
      const rules = await this.repos.allowRules.list(target.workspaceId)
      // A guarded action is only covered by a rule for exactly this command.
      const usable = guarded ? rules.filter((r) => r.pattern?.startsWith('=')) : rules
      if (isAllowed(usable, req)) return { allow: true }
    }

    const decision = await this.repos.decisions.open({
      ticketId: target.ticketId,
      agentRunId: target.runId,
      kind: 'permission',
      // The guard's reason tells the user why Mainbus is asking.
      question: describeRequest(req, 'Implementer') + (req.reason ? ` — ${req.reason}` : ''),
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
      await this.repos.allowRules.add(ruleFromRequest(target.workspaceId, req, { exact: guarded }))
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
    return { runId: run.id, ticketId: ticket.id, workspaceId: ticket.workspaceId }
  }

  private async workspaceOf(ticket: Ticket): Promise<Workspace> {
    const workspace = await this.repos.workspaces.get()
    if (!workspace || workspace.id !== ticket.workspaceId) throw new Error(`No workspace for ticket ${ticket.id}`)
    return workspace
  }
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
