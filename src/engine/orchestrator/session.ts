import fs from 'node:fs/promises'
import path from 'node:path'
import type { EngineEvent } from '../../shared/api'
import type { Proposal } from '../../shared/proposals'
import type { Ticket, Workspace } from '../../shared/domain'
import type { AgentEvent, OrchestratorStatus, OrchestratorThread, StoredEvent, ThreadEvent } from '../../shared/events'
import type { ProposalKindName } from '../../shared/proposals'
import type { ProposalService } from '../proposals/service'
import { conversationDigest } from '../runner/digest'
import {
  ResumeFailedError,
  type AgentRuntime,
  type OrchestratorReadToolHandlers,
  type OrchestratorRunSpec,
  type RunHandle
} from '../runtime/types'
import type { OrchestratorRepo } from '../store/orchestrator'
import { ORCHESTRATOR_DISALLOWED, ORCHESTRATOR_EFFORT, ORCHESTRATOR_MODEL } from './config'
import { withHeader } from './header'
import { orchestratorVerdict } from './permissions'
import { buildOrchestratorPrompt } from './prompt'

export const EMPTY_MESSAGE = 'Type a message first'
export const BUSY_MESSAGE = 'The orchestrator is still working: wait for it, or Stop it first'
export const RESUME_FAILED_NOTICE =
  "Couldn't resume the earlier conversation; started a new one from a digest of its last messages."

/** What a propose tool answers once the proposal is stored. */
export function proposedText(id: string): string {
  return `Proposed ${id}. The user will confirm, change or reject it, and you'll hear the outcome in your next turn. End your turn now.`
}

export const NO_TURN_MESSAGE = 'Mainbus could not tell which message of the user this turn answers, so nothing was stored.'

/** How long shutdown waits for a queued message to finish starting, and for the last events to land. */
const SHUTDOWN_SETTLE_MS = 5000

export interface OrchestratorDeps {
  repo: OrchestratorRepo
  runtime: AgentRuntime
  /** The data home: the orchestrator works in its `orchestrator` folder. */
  homeRoot: string
  now: () => Date
  emit: (e: EngineEvent) => void
  /** The open workspace, or null; send() rejects with `workspaceRequired` when there is none. */
  workspace: () => Promise<Workspace | null>
  workspaceRequired: string
  readTools: OrchestratorReadToolHandlers
  proposals: ProposalService
}

interface Live {
  runId: string
  handle: RunHandle
  done: Promise<void>
}

function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const gaveUp = new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))
  return Promise.race([p.then(() => {}, () => {}), gaveUp]).finally(() => clearTimeout(timer))
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The one orchestrator session of this data home. It starts on the first message, stays live between messages,
 * and after a restart the next message resumes it by session id (or, when that fails, starts a fresh one from a
 * digest of the conversation). It never touches tickets, the board or unattended mode.
 */
export class OrchestratorSession {
  private status: OrchestratorStatus = 'idle'
  private live: Live | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private shuttingDown = false
  /** The user's message, as typed, that the current turn answers; null between turns. */
  private turnMessage: string | null = null

  constructor(private readonly deps: OrchestratorDeps) {}

  get folder(): string {
    return path.join(this.deps.homeRoot, 'orchestrator')
  }

  async get(): Promise<OrchestratorThread> {
    const runs = await this.deps.repo.list()
    const events = (await Promise.all(runs.map((run) => this.deps.repo.events(run.id)))).flat()
    return {
      status: this.status,
      runs: runs.map(({ id, startedAt, endedAt, endReason }) => ({ id, startedAt, endedAt, endReason })),
      events,
      proposals: await this.deps.proposals.list()
    }
  }

  async send(text: string): Promise<void> {
    if (typeof text !== 'string' || text.trim() === '') throw new Error(EMPTY_MESSAGE)
    return this.serial(() => this.sendNow(text))
  }

  /** Interrupts the current turn; the session stays, and the next message goes to it. */
  async stop(): Promise<void> {
    return this.serial(async () => {
      if (this.live && this.status === 'working') await this.deps.runtime.interrupt(this.live.handle)
    })
  }

  /** The app is quitting: the turn under way just ends, and the run stays open for the next launch to resume. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    await settleWithin(this.chain, SHUTDOWN_SETTLE_MS)
    const live = this.live
    if (!live) return
    await this.deps.runtime.stop(live.handle).catch(() => {})
    await settleWithin(live.done, SHUTDOWN_SETTLE_MS)
  }

  /** Runs `step` after the earlier actions; a failed step does not block later ones. */
  private serial<T>(step: () => Promise<T>): Promise<T> {
    const result = this.chain.then(step)
    this.chain = result.catch(() => {})
    return result
  }

  private async sendNow(text: string): Promise<void> {
    if (this.shuttingDown) throw new Error('Mainbus is shutting down')
    // A message sent mid-turn would join the turn under way (at its next tool boundary), so the turn's one
    // message would no longer be the user's only one; a proposal's intent must be the words of its own turn.
    if (this.status === 'working') throw new Error(BUSY_MESSAGE)
    const ws = await this.deps.workspace()
    if (!ws) throw new Error(this.deps.workspaceRequired)
    // The proposals decided since the user's last message open this one; read before it is recorded.
    const outcomes = await this.deps.proposals.outcomeBlock(await this.deps.repo.lastUserMessageAt())
    const opened = (body: string): string => (outcomes === null ? body : `${outcomes}\n\n${body}`)
    const prompt = withHeader(ws, this.deps.now(), text)

    if (this.live) {
      // The panel shows what the user typed; the agent gets it with the header.
      const live = this.live
      await this.record(live.runId, { kind: 'user_message', text })
      this.setStatus('working')
      this.turnMessage = text
      try {
        await this.deps.runtime.send(live.handle, opened(prompt))
      } catch (err) {
        this.turnMessage = null
        this.setStatus('idle')
        throw err
      }
      return
    }

    await fs.mkdir(this.folder, { recursive: true })
    const open = await this.deps.repo.latestOpen()
    let runId = open?.id ?? (await this.deps.repo.create()).id
    const message = await this.record(runId, { kind: 'user_message', text })
    this.setStatus('working')
    this.turnMessage = text
    try {
      if (open?.sessionId) {
        try {
          await this.launch(runId, ws, opened(prompt), open.sessionId)
          return
        } catch (err) {
          if (!(err instanceof ResumeFailedError)) throw err
        }
        const earlier = (await this.deps.repo.events(runId)).filter((e) => e.seq < message.seq)
        await this.deps.repo.end(runId, 'resume_failed')
        runId = (await this.deps.repo.create()).id
        await this.record(runId, { kind: 'notice', text: RESUME_FAILED_NOTICE })
        await this.launch(runId, ws, opened(`${conversationDigest(earlier)}\n\n${prompt}`))
        return
      }
      await this.launch(runId, ws, opened(prompt))
    } catch (err) {
      this.turnMessage = null
      await this.record(runId, { kind: 'error', message: errorText(err) }).catch(() => {})
      this.setStatus('failed')
      throw err
    }
  }

  /**
   * The user dragged a Backlog or Ready card into In progress: a start proposal for the whole lineup, made by the
   * engine and shown in the thread. It is no orchestrator turn: nothing is sent to the agent and its status stays;
   * it hears the outcome in its next turn like any proposal. A start already pending for the ticket is returned.
   */
  proposeStartFromDrag(ticket: Ticket): Promise<Proposal> {
    return this.serial(async () => {
      if (this.shuttingDown) throw new Error('Mainbus is shutting down')
      const ws = await this.deps.workspace()
      if (!ws || ws.id !== ticket.workspaceId) throw new Error(this.deps.workspaceRequired)
      const pending = (await this.deps.proposals.list()).find(
        (p) => p.status === 'pending' && p.kind === 'start_lineup' && (p.payload as { ticketId?: string }).ticketId === ticket.id
      )
      if (pending) return pending
      // With no session yet the run is just a place for the card; the next message launches it.
      const runId = this.live?.runId ?? (await this.deps.repo.latestOpen())?.id ?? (await this.deps.repo.create()).id
      const made = await this.deps.proposals.propose(
        'start_lineup',
        { ticket: ticket.number, reason: `You dragged #${ticket.number} ${JSON.stringify(ticket.title)} into In progress.` },
        { workspaceId: ws.id, orchestratorRunId: runId, userMessage: null, origin: 'drag' }
      )
      if (!made.ok) throw new Error(made.error)
      await this.record(runId, { kind: 'proposal', proposalId: made.proposal.id, from: 'drag' })
      return made.proposal
    })
  }

  /**
   * A propose tool: stores the proposal, made from the message the current turn answers, and puts its card in
   * the thread here. An invalid one stores nothing, and the orchestrator is told why.
   */
  private async propose(kind: ProposalKindName, input: unknown): Promise<string> {
    const live = this.live
    const userMessage = this.turnMessage
    if (!live || userMessage === null) return NO_TURN_MESSAGE
    const ws = await this.deps.workspace()
    if (!ws) return `${this.deps.workspaceRequired}. Nothing was stored.`
    const made = await this.deps.proposals.propose(kind, input, {
      workspaceId: ws.id,
      orchestratorRunId: live.runId,
      userMessage
    })
    if (!made.ok) return `Invalid proposal: ${made.error}. Nothing was stored; fix it and propose again.`
    await this.record(live.runId, { kind: 'proposal', proposalId: made.proposal.id })
    return proposedText(made.proposal.id)
  }

  private async launch(runId: string, ws: Workspace, prompt: string, resumeSessionId?: string): Promise<void> {
    const cwd = this.folder
    const spec: OrchestratorRunSpec = {
      kind: 'orchestrator',
      cwd,
      prompt,
      appendSystemPrompt: buildOrchestratorPrompt(),
      model: ORCHESTRATOR_MODEL,
      effort: ORCHESTRATOR_EFFORT,
      additionalDirectories: [ws.repoPath],
      disallowedTools: ORCHESTRATOR_DISALLOWED,
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
      tools: {
        ...this.deps.readTools,
        proposeCreateTickets: (a) => this.propose('create_tickets', a),
        proposeStart: (a) => this.propose('start_lineup', a),
        proposePause: (a) => this.propose('pause', a),
        proposeStop: (a) => this.propose('stop', a),
        proposeSkip: (a) => this.propose('skip', a)
      },
      onPermission: async (req) => orchestratorVerdict(req.toolName, req.input, { cwd, repo: ws.repoPath })
    }
    const handle = await this.deps.runtime.start(spec)
    if (this.shuttingDown) {
      await this.deps.runtime.stop(handle).catch(() => {})
      return
    }
    const live: Live = { runId, handle, done: Promise.resolve() }
    this.live = live
    live.done = this.pump(live)
  }

  private async pump(live: Live): Promise<void> {
    try {
      for await (const event of this.deps.runtime.events(live.handle)) {
        try {
          await this.onEvent(live, event)
        } catch (err) {
          if (!this.shuttingDown) {
            await this.record(live.runId, { kind: 'error', message: `Mainbus could not handle an orchestrator event: ${errorText(err)}` }).catch(() => {})
          }
        }
      }
    } catch (err) {
      if (!this.shuttingDown) await this.record(live.runId, { kind: 'error', message: errorText(err) }).catch(() => {})
    }
    if (this.live === live) {
      this.live = null
      // Its turn is over: the next message starts a new session.
      this.turnMessage = null
    }
    // Quitting ends the turn under way and records nothing more: the run stays open for the next launch.
    if (this.shuttingDown) return
    await this.record(live.runId, { kind: 'process_exit', code: null }).catch(() => {})
    if (this.status === 'working') this.setStatus('failed')
  }

  private async onEvent(live: Live, event: AgentEvent): Promise<void> {
    if (this.shuttingDown) return
    if ((event.kind === 'message' || event.kind === 'thinking') && event.partial) {
      // Streaming previews are shown but never stored; the final event follows.
      const preview: StoredEvent = { runId: live.runId, seq: 0, at: this.deps.now().toISOString(), event }
      this.deps.emit({ type: 'orchestrator.appended', event: preview })
      return
    }
    if (event.kind === 'session') await this.deps.repo.setSession(live.runId, event.sessionId)
    await this.record(live.runId, event)
    if (event.kind === 'turn_end') {
      this.turnMessage = null
      this.setStatus(event.ok || event.interrupted ? 'idle' : 'failed')
    }
  }

  private async record(runId: string, event: ThreadEvent): Promise<StoredEvent> {
    const stored = await this.deps.repo.append(runId, event)
    this.deps.emit({ type: 'orchestrator.appended', event: stored })
    return stored
  }

  private setStatus(status: OrchestratorStatus): void {
    if (this.status === status) return
    this.status = status
    this.deps.emit({ type: 'orchestrator.status', status })
  }
}
