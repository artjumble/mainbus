import fs from 'node:fs/promises'
import path from 'node:path'
import type { EngineEvent } from '../../shared/api'
import type { Proposal } from '../../shared/proposals'
import type { IntentAddition, NewTicketInput, Ticket, Workspace } from '../../shared/domain'
import type { AgentEvent, OrchestratorStatus, OrchestratorThread, StoredEvent, ThreadEvent } from '../../shared/events'
import type { ProposalKindName } from '../../shared/proposals'
import { answeredBlock, type AnsweredDecision } from './answeredBlock'
import { releasedHoldsBlock, type ReleasedHold } from './releasedHoldsBlock'
import { resurfacedBlock, type ResurfacedDecision } from './resurfacedBlock'
import { stuckBlock, type StuckReport } from './stuckBlock'
import { wakeDigest, wakeLine, type OpenDecision, type WakeItem } from './wakeDigest'
import { ticketFoldersFor, type HomePaths } from '../home'
import { createInBacklog, listJoin } from '../proposals/createTickets'
import { ProposalInvalid } from '../proposals/kind'
import type { ProposalService } from '../proposals/service'
import { conversationDigest } from '../runner/digest'
import {
  ResumeFailedError,
  type AgentRuntime,
  type OrchestratorReadToolHandlers,
  type OrchestratorRunSpec,
  type RunHandle
} from '../runtime/types'
import { isUsageLimitText, type UsageLimit } from '../runner/usageLimit'
import type { OrchestratorRepo } from '../store/orchestrator'
import type { Wake, WakeRepo } from '../store/wakes'
import { ORCHESTRATOR_DISALLOWED, ORCHESTRATOR_EFFORT, ORCHESTRATOR_MODEL } from './config'
import { withHeader } from './header'
import { orchestratorVerdict } from './permissions'
import { resolveTargetWorkspace, resolveWorkspaceRef } from './workspaceRef'
import { buildOrchestratorPrompt } from './prompt'

export const EMPTY_MESSAGE = 'Type a message first'
export const BUSY_MESSAGE = 'The orchestrator is still working: wait for it, or Stop it first'
export const RESUME_FAILED_NOTICE =
  "Couldn't resume the earlier conversation; started a new one from a digest of its last messages."

/** What a propose tool answers once the proposal is stored. */
export function proposedText(id: string): string {
  return `Proposed ${id}. The user will confirm, change or reject it, and you'll hear the outcome in your next turn. End your turn now.`
}

/** What a propose tool answers when the same proposal is already waiting for the user. */
export function pendingText(id: string): string {
  return `Proposal ${id} for this is already pending: the user hasn't decided on it yet, so nothing new was stored. End your turn now.`
}

export const NO_TURN_MESSAGE = 'Mainbus could not tell which message of the user this turn answers, so nothing was stored.'

export const WAKE_CREATE_MESSAGE = 'Tickets can only be created in answer to a message of the user. Nothing was created.'

/** How far back request_messages_back may reach. */
export const MAX_MESSAGES_BACK = 5

/** What create_tickets answers once the tickets exist. */
export function createdText(workspace: string, tickets: { number: number; title: string }[]): string {
  const list = listJoin(tickets.map((t) => `#${t.number} ${JSON.stringify(t.title)}`))
  return `Created ${list} in ${workspace}'s Backlog. Tell the user which workspace they went into.`
}

/** How long shutdown waits for a queued message to finish starting, and for the last events to land. */
const SHUTDOWN_SETTLE_MS = 5000

export interface OrchestratorDeps {
  repo: OrchestratorRepo
  runtime: AgentRuntime
  /** The data home: the orchestrator works in its `orchestrator` folder. */
  homeRoot: string
  /** The data home's folders: every open workspace's ticket folders are readable. */
  paths: HomePaths
  now: () => Date
  emit: (e: EngineEvent) => void
  /** The focused workspace, or null; send() rejects with `workspaceRequired` when there is none. */
  focused: () => Promise<Workspace | null>
  /** Every open workspace, oldest first. */
  workspaces: () => Promise<Workspace[]>
  /** The workspace of this decision's ticket, or null when the decision is unknown. */
  decisionWorkspace: (decisionId: string) => Promise<string | null>
  workspaceRequired: string
  readTools: OrchestratorReadToolHandlers
  proposals: ProposalService
  /** The one way tickets are created (as a confirmed proposal's are): all of them or none, emitting board.changed. */
  createTickets: (ws: Workspace, inputs: Omit<NewTicketInput, 'workspaceId'>[]) => Promise<Ticket[]>
  /** The decisions the user answered since `since` in any workspace, for the start of a message. */
  answeredSince: (since: string | null) => Promise<AnsweredDecision[]>
  /** The tickets whose hold was released since `since` in any workspace, by hand, by a start or by their date. */
  releasedSince: (since: string | null) => Promise<ReleasedHold[]>
  /** The decisions the user put off that came back on their date since `since`. */
  resurfacedSince: (since: string | null) => Promise<ResurfacedDecision[]>
  /** The stuck episodes opened or escalated since `since` that are still open. */
  stuckSince: (since: string | null) => Promise<StuckReport[]>
  /** The wake queue's rows, to be marked as presented and acknowledged. */
  wakes: Pick<WakeRepo, 'markPresented' | 'ack'>
  /** The app-wide usage limit, told when the orchestrator's own turns run into it. */
  usage?: {
    rateLimit(event: Extract<AgentEvent, { kind: 'rate_limit' }>, runId: string | null): void
    hit(limit: UsageLimit, runId: string | null): void
  }
  /**
   * What the pending wake rows are about now: the item for each row that still has something to say, the rows
   * whose ticket or referent is gone, and every open decision of every workspace.
   */
  wakeItems: (
    rows: Wake[]
  ) => Promise<{ presented: { row: Wake; item: WakeItem }[]; gone: Wake[]; open: OpenDecision[] }>
  /** An orchestrator turn ended: for a wake turn, `finished` is false when it failed or was interrupted. The wake queue starts the next turn from it. */
  onTurnEnded?: (finished: boolean) => void
}

/** What the current turn answers: a message of the user, or the wake rows Mainbus presented. */
type Turn = { kind: 'user'; message: string } | { kind: 'wake'; rowIds: string[] }

interface Live {
  runId: string
  handle: RunHandle
  done: Promise<void>
  /** The folders the session was started able to read; the SDK fixes them at launch. */
  readableKey: string
  /** Ended on purpose to relaunch with other folders: not a failure, and nothing is recorded for it. */
  retired?: boolean
}

function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const gaveUp = new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))
  return Promise.race([p.then(() => {}, () => {}), gaveUp]).finally(() => clearTimeout(timer))
}

/** Takes the optional `workspace` off a propose tool's input. */
function splitWorkspace(input: unknown): { workspace: string | undefined; rest: unknown } {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || !('workspace' in input)) {
    return { workspace: undefined, rest: input }
  }
  const { workspace, ...rest } = input as Record<string, unknown>
  return { workspace: typeof workspace === 'string' ? workspace : undefined, rest }
}

/** Takes the optional `request_messages_back` off a tool's input. */
function splitMessagesBack(input: unknown): { back: unknown; rest: unknown } {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || !('request_messages_back' in input)) {
    return { back: undefined, rest: input }
  }
  const { request_messages_back: back, ...rest } = input as Record<string, unknown>
  return { back, rest }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The one orchestrator session of this data home. It starts on the first message, stays live between messages,
 * and after a restart the next message resumes it by session id (or, when that fails, starts a fresh one from a
 * digest of the conversation). It never touches the board or unattended mode, and touches tickets only to create
 * them in a Backlog when the user asks (create_tickets).
 */
export class OrchestratorSession {
  private status: OrchestratorStatus = 'idle'
  private live: Live | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private shuttingDown = false
  /** What the current turn answers; null between turns. */
  private turn: Turn | null = null
  /** Wake turns queued or being started. */
  private starting = 0

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

  /** True while a turn is running or a wake turn is being started. */
  get busy(): boolean {
    return this.status === 'working' || this.starting > 0
  }

  /**
   * Gives the orchestrator a turn of its own for these wake rows. Nothing happens while a turn is running: the rows
   * stay pending and are presented later. They are acknowledged only when the turn finishes.
   */
  wake(rows: Wake[]): Promise<void> {
    this.starting++
    return this.serial(() => this.wakeNow(rows)).finally(() => this.starting--)
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
    const ws = await this.deps.focused()
    if (!ws) throw new Error(this.deps.workspaceRequired)
    // The proposals decided since the user's last message open this one; read before it is recorded.
    const since = await this.deps.repo.lastUserMessageAt()
    const blocks = [
      await this.deps.proposals.outcomeBlock(since),
      answeredBlock(await this.deps.answeredSince(since)),
      releasedHoldsBlock(await this.deps.releasedSince(since)),
      resurfacedBlock(await this.deps.resurfacedSince(since)),
      stuckBlock(await this.deps.stuckSince(since))
    ].filter((b) => b !== null)
    const outcomes = blocks.length === 0 ? null : blocks.join('\n\n')
    const opened = (body: string): string => (outcomes === null ? body : `${outcomes}\n\n${body}`)
    const prompt = withHeader(ws, this.deps.now(), text)
    await this.beginTurn(ws, { kind: 'user_message', text }, { kind: 'user', message: text }, prompt, opened)
  }

  private async wakeNow(rows: Wake[]): Promise<void> {
    if (this.shuttingDown || this.status === 'working') return
    const ws = await this.deps.focused()
    if (!ws) return
    const { presented, gone, open } = await this.deps.wakeItems(rows)
    // News whose ticket is gone has nothing to say.
    await this.deps.wakes.ack(gone.map((r) => r.id))
    if (presented.length === 0) return
    const rowIds = presented.map((p) => p.row.id)
    await this.deps.wakes.markPresented(rowIds)
    const items = presented.map((p) => p.item)
    const prompt = withHeader(ws, this.deps.now(), wakeDigest(items, open))
    await this.beginTurn(ws, { kind: 'wake', items: items.map(wakeLine) }, { kind: 'wake', rowIds }, prompt, (body) => body)
  }

  /**
   * Starts a turn: records `shown` in the thread, then sends `prompt` to the live session, or starts one (resuming the
   * run's session when it has one, or from a digest of the conversation when that fails). `wrap` puts whatever opens
   * the turn before the prompt.
   */
  private async beginTurn(ws: Workspace, shown: ThreadEvent, turn: Turn, prompt: string, wrap: (body: string) => string): Promise<void> {
    // The SDK fixes the folders a session can read at launch: a workspace opened or removed since means starting it
    // again (resuming the same conversation), so every repo stays readable.
    if (this.live && this.live.readableKey !== (await this.readable()).key) await this.retire(this.live)
    if (this.live) {
      // The panel shows what the user typed; the agent gets it with the header.
      const live = this.live
      await this.record(live.runId, shown)
      this.setStatus('working')
      this.turn = turn
      try {
        await this.deps.runtime.send(live.handle, wrap(prompt))
      } catch (err) {
        this.turn = null
        this.setStatus('idle')
        if (turn.kind === 'wake') this.deps.onTurnEnded?.(false)
        throw err
      }
      return
    }

    await fs.mkdir(this.folder, { recursive: true })
    const open = await this.deps.repo.latestOpen()
    let runId = open?.id ?? (await this.deps.repo.create()).id
    const message = await this.record(runId, shown)
    this.setStatus('working')
    this.turn = turn
    try {
      if (open?.sessionId) {
        try {
          await this.launch(runId, ws, wrap(prompt), open.sessionId)
          return
        } catch (err) {
          if (!(err instanceof ResumeFailedError)) throw err
        }
        const earlier = (await this.deps.repo.events(runId)).filter((e) => e.seq < message.seq)
        await this.deps.repo.end(runId, 'resume_failed')
        runId = (await this.deps.repo.create()).id
        await this.record(runId, { kind: 'notice', text: RESUME_FAILED_NOTICE })
        await this.launch(runId, ws, wrap(`${conversationDigest(earlier)}\n\n${prompt}`))
        return
      }
      await this.launch(runId, ws, wrap(prompt))
    } catch (err) {
      this.turn = null
      await this.record(runId, { kind: 'error', message: errorText(err) }).catch(() => {})
      this.setStatus('failed')
      if (turn.kind === 'wake') this.deps.onTurnEnded?.(false)
      throw err
    }
  }

  /**
   * The user dragged a Backlog or Ready card into In progress: a start proposal for the whole lineup, made by the
   * engine and shown in the thread. It is no orchestrator turn: nothing is sent to the agent and its status stays;
   * it hears the outcome in its next turn like any proposal. A start already pending for the ticket is returned.
   */
  proposeStartFromDrag(ticket: Ticket): Promise<Proposal> {
    return this.proposeFromUser(ticket, 'start_lineup', 'drag', {
      ticket: ticket.number,
      reason: `You dragged #${ticket.number} ${JSON.stringify(ticket.title)} into In progress.`
    })
  }

  /**
   * "Ask the orchestrator to start an agent once it's in Ready": the ticket reached Ready, so the engine makes the same
   * start proposal a drag does, shown in the thread. No orchestrator turn happens.
   */
  proposeStartWhenReady(ticket: Ticket): Promise<Proposal> {
    return this.proposeFromUser(ticket, 'start_lineup', 'button', {
      ticket: ticket.number,
      reason: `You asked for #${ticket.number} ${JSON.stringify(ticket.title)} to be proposed for starting once it was in Ready.`
    })
  }

  /**
   * The user pressed Replace… on a ticket: a replace proposal for its active role, made by the engine and shown in the
   * thread like a drag's start. No stuck episode is needed, and no orchestrator turn happens. A replace already
   * pending for the ticket is returned.
   */
  proposeReplaceFromButton(ticket: Ticket): Promise<Proposal> {
    const text = `You pressed Replace… on #${ticket.number} ${JSON.stringify(ticket.title)}.`
    return this.proposeFromUser(ticket, 'replace', 'button', { ticket: ticket.number, reason: text, evidence: text })
  }

  private proposeFromUser(ticket: Ticket, kind: ProposalKindName, from: 'drag' | 'button', input: unknown): Promise<Proposal> {
    return this.serial(async () => {
      if (this.shuttingDown) throw new Error('Mainbus is shutting down')
      // The ticket's own workspace, whichever one is focused.
      const ws = (await this.deps.workspaces()).find((w) => w.id === ticket.workspaceId)
      if (!ws) throw new Error('The workspace of that ticket was removed')
      // With no session yet the run is just a place for the card; the next message launches it.
      const runId = this.live?.runId ?? (await this.deps.repo.latestOpen())?.id ?? (await this.deps.repo.create()).id
      const made = await this.deps.proposals.propose(kind, input, { workspaceId: ws.id, orchestratorRunId: runId, userMessage: null, origin: from })
      if (!made.ok) throw new Error(made.error)
      // One already pending for the ticket comes back as it is, its card already in the thread.
      if (made.existing) return made.proposal
      await this.record(runId, { kind: 'proposal', proposalId: made.proposal.id, from })
      return made.proposal
    })
  }

  /**
   * A propose tool: stores the proposal, made from the message the current turn answers, and puts its card in
   * the thread here. An invalid one stores nothing, and the orchestrator is told why.
   */
  private async propose(kind: ProposalKindName, input: unknown): Promise<string> {
    const live = this.live
    const turn = this.turn
    if (!live || turn === null) return NO_TURN_MESSAGE
    // A wake turn answers no message of the user: the kinds that need one refuse it themselves.
    let userMessage = turn.kind === 'user' ? turn.message : null
    let followUps: IntentAddition[] | undefined
    // `workspace` names the ticket's workspace (or where new tickets go); the kinds' own schemas do not know it.
    let { workspace: ref, rest } = splitWorkspace(input)
    if (kind === 'create_tickets') {
      // Only drafts carry the user's words; the other kinds' strict schemas refuse request_messages_back.
      const split = splitMessagesBack(rest)
      rest = split.rest
      if (userMessage !== null) {
        const req = await this.request(userMessage, split.back)
        if (!req.ok) return `Invalid proposal: ${req.error}. Nothing was stored; fix it and propose again.`
        userMessage = req.userMessage
        followUps = req.followUps
      }
    }
    let workspaceId: string
    if (kind === 'answer') {
      // A decision belongs to one ticket, so it has one workspace.
      const given = (rest as { decision?: unknown } | null)?.decision
      const decision = typeof given === 'string' ? given : null
      const found = decision === null ? null : await this.deps.decisionWorkspace(decision)
      if (found === null) return `Invalid proposal: decision: there is no decision ${decision ?? ''}. Nothing was stored; fix it and propose again.`
      workspaceId = found
    } else {
      const focused = await this.deps.focused()
      if (!focused) return `${this.deps.workspaceRequired}. Nothing was stored.`
      const resolved = resolveWorkspaceRef(await this.deps.workspaces(), focused, ref)
      if (!resolved.ok) return `${resolved.text} Nothing was stored; fix it and propose again.`
      workspaceId = resolved.ws.id
    }
    const made = await this.deps.proposals.propose(kind, rest, {
      workspaceId,
      orchestratorRunId: live.runId,
      userMessage,
      ...(followUps ? { followUps } : {})
    })
    if (!made.ok) return `Invalid proposal: ${made.error}. Nothing was stored; fix it and propose again.`
    if (made.existing) return pendingText(made.proposal.id)
    await this.record(live.runId, { kind: 'proposal', proposalId: made.proposal.id })
    return proposedText(made.proposal.id)
  }

  /**
   * The user's request that drafts are made from: this turn's message (`back` 0 or left out), or the one `back` messages
   * before it, followed by every later message up to this turn's, verbatim.
   */
  private async request(
    message: string,
    back: unknown
  ): Promise<{ ok: true; userMessage: string; followUps?: IntentAddition[] } | { ok: false; error: string }> {
    if (back === undefined || back === null || back === 0) return { ok: true, userMessage: message }
    if (typeof back !== 'number' || !Number.isInteger(back) || back < 0 || back > MAX_MESSAGES_BACK) {
      return { ok: false, error: `request_messages_back: must be a whole number from 0 to ${MAX_MESSAGES_BACK}` }
    }
    const messages = await this.deps.repo.recentUserMessages(back + 1)
    if (messages.length < back + 1) {
      const earlier = messages.length - 1
      const have = earlier === 0 ? 'is no earlier message' : earlier === 1 ? 'is only 1 earlier message' : `are only ${earlier} earlier messages`
      return { ok: false, error: `request_messages_back: there ${have} of the user` }
    }
    const [first, ...followUps] = messages
    return { ok: true, userMessage: first!.text, followUps }
  }

  /**
   * create_tickets: creates the drafts in a workspace's Backlog at once, with no card, and puts a receipt in the thread.
   * Everything is checked first: an invalid call creates nothing, and the orchestrator is told why.
   */
  private async createNow(input: unknown): Promise<string> {
    const live = this.live
    const turn = this.turn
    if (!live || turn === null) return NO_TURN_MESSAGE
    if (turn.kind !== 'user') return WAKE_CREATE_MESSAGE
    const { workspace: ref, rest } = splitWorkspace(input)
    const target = resolveTargetWorkspace(await this.deps.workspaces(), ref)
    if (!target.ok) return `${target.text} Nothing was created.`
    const { back, rest: drafts } = splitMessagesBack(rest)
    const req = await this.request(turn.message, back)
    if (!req.ok) return `Invalid: ${req.error}. Nothing was created; fix it and try again.`
    let created: Ticket[]
    try {
      created = await createInBacklog(drafts, req, target.ws, this.deps.createTickets)
    } catch (err) {
      if (err instanceof ProposalInvalid) return `Invalid: ${err.message}. Nothing was created; fix it and try again.`
      throw err
    }
    const tickets = created.map((t) => ({ id: t.id, number: t.number, title: t.title }))
    await this.record(live.runId, { kind: 'tickets_created', workspaceId: target.ws.id, workspace: target.ws.name, tickets })
    return createdText(target.ws.name, tickets)
  }

  /**
   * Every open workspace's repo and ticket folders: the whole folder, not each ticket's, because tickets start and
   * finish while the session runs. The folders exist up front because the CLI may skip a folder it cannot find.
   */
  private async readable(): Promise<{ folders: string[]; ticketFolders: string[]; key: string }> {
    const all = await this.deps.workspaces()
    const ticketFolders = all.map((w) => ticketFoldersFor(this.deps.paths, w.slug))
    await Promise.all(ticketFolders.map((f) => fs.mkdir(f, { recursive: true })))
    const folders = [...all.map((w) => w.repoPath), ...ticketFolders]
    return { folders, ticketFolders, key: JSON.stringify(folders) }
  }

  /** Ends the live session without recording a failure; the run stays open to be resumed. */
  private async retire(live: Live): Promise<void> {
    live.retired = true
    await this.deps.runtime.stop(live.handle).catch(() => {})
    await live.done
    if (this.live === live) this.live = null
  }

  private async launch(runId: string, ws: Workspace, prompt: string, resumeSessionId?: string): Promise<void> {
    const cwd = this.folder
    const { folders: readable, ticketFolders, key } = await this.readable()
    const spec: OrchestratorRunSpec = {
      kind: 'orchestrator',
      cwd,
      prompt,
      appendSystemPrompt: buildOrchestratorPrompt(ticketFolders),
      model: ORCHESTRATOR_MODEL,
      effort: ORCHESTRATOR_EFFORT,
      additionalDirectories: readable,
      disallowedTools: ORCHESTRATOR_DISALLOWED,
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
      tools: {
        ...this.deps.readTools,
        createTickets: (a) => this.createNow(a),
        proposeCreateTickets: (a) => this.propose('create_tickets', a),
        proposeStart: (a) => this.propose('start_lineup', a),
        proposePause: (a) => this.propose('pause', a),
        proposeStop: (a) => this.propose('stop', a),
        proposeSkip: (a) => this.propose('skip', a),
        proposeHold: (a) => this.propose('hold', a),
        proposeAnswer: (a) => this.propose('answer', a),
        proposeRedirect: (a) => this.propose('redirect', a),
        proposeReplace: (a) => this.propose('replace', a),
        proposePromote: (a) => this.propose('promote', a)
      },
      onPermission: async (req) => orchestratorVerdict(req.toolName, req.input, { cwd, readable })
    }
    const handle = await this.deps.runtime.start(spec)
    if (this.shuttingDown) {
      await this.deps.runtime.stop(handle).catch(() => {})
      return
    }
    const live: Live = { runId, handle, done: Promise.resolve(), readableKey: key }
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
    if (live.retired) return
    const cutShort = this.turn
    if (this.live === live) {
      this.live = null
      // Its turn is over: the next message starts a new session.
      this.turn = null
    }
    // Quitting ends the turn under way and records nothing more: the run stays open for the next launch.
    if (this.shuttingDown) return
    // A wake turn cut short leaves its rows pending.
    if (cutShort?.kind === 'wake') this.deps.onTurnEnded?.(false)
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
    // A usage limit is the whole app's: the agents pause too, and wake turns wait for the reset.
    if (event.kind === 'rate_limit') this.deps.usage?.rateLimit(event, null)
    if (event.kind === 'turn_end') {
      const turn = this.turn
      this.turn = null
      this.setStatus(event.ok || event.interrupted ? 'idle' : 'failed')
      if (!event.ok && isUsageLimitText(event.error)) this.deps.usage?.hit({ resetsAt: null }, null)
      const finished = event.ok && !event.interrupted
      // Acknowledged only now that the turn finished: a failed or interrupted one leaves its rows to be presented again.
      if (turn?.kind === 'wake' && finished) await this.deps.wakes.ack(turn.rowIds)
      if (turn?.kind === 'wake' || finished) this.deps.onTurnEnded?.(finished)
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
