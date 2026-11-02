import fs from 'node:fs/promises'
import path from 'node:path'
import type { EngineEvent } from '../../shared/api'
import type { Workspace } from '../../shared/domain'
import type { AgentEvent, OrchestratorStatus, OrchestratorThread, StoredEvent, ThreadEvent } from '../../shared/events'
import { conversationDigest } from '../runner/digest'
import {
  ResumeFailedError,
  type AgentRuntime,
  type OrchestratorRunSpec,
  type OrchestratorToolHandlers,
  type RunHandle
} from '../runtime/types'
import type { OrchestratorRepo } from '../store/orchestrator'
import { ORCHESTRATOR_DISALLOWED, ORCHESTRATOR_EFFORT, ORCHESTRATOR_MODEL } from './config'
import { withHeader } from './header'
import { orchestratorVerdict } from './permissions'
import { buildOrchestratorPrompt } from './prompt'

export const EMPTY_MESSAGE = 'Type a message first'
export const RESUME_FAILED_NOTICE =
  "Couldn't resume the earlier conversation; started a new one from a digest of its last messages."

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
  readTools: OrchestratorToolHandlers
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
      events
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
    const ws = await this.deps.workspace()
    if (!ws) throw new Error(this.deps.workspaceRequired)
    const prompt = withHeader(ws, this.deps.now(), text)

    if (this.live) {
      // The panel shows what the user typed; the agent gets it with the header.
      await this.record(this.live.runId, { kind: 'user_message', text })
      this.setStatus('working')
      await this.deps.runtime.send(this.live.handle, prompt)
      return
    }

    await fs.mkdir(this.folder, { recursive: true })
    const open = await this.deps.repo.latestOpen()
    let runId = open?.id ?? (await this.deps.repo.create()).id
    const message = await this.record(runId, { kind: 'user_message', text })
    this.setStatus('working')
    try {
      if (open?.sessionId) {
        try {
          await this.launch(runId, ws, prompt, open.sessionId)
          return
        } catch (err) {
          if (!(err instanceof ResumeFailedError)) throw err
        }
        const earlier = (await this.deps.repo.events(runId)).filter((e) => e.seq < message.seq)
        await this.deps.repo.end(runId, 'resume_failed')
        runId = (await this.deps.repo.create()).id
        await this.record(runId, { kind: 'notice', text: RESUME_FAILED_NOTICE })
        await this.launch(runId, ws, `${conversationDigest(earlier)}\n\n${prompt}`)
        return
      }
      await this.launch(runId, ws, prompt)
    } catch (err) {
      await this.record(runId, { kind: 'error', message: errorText(err) }).catch(() => {})
      this.setStatus('failed')
      throw err
    }
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
      readTools: this.deps.readTools,
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
    if (this.live === live) this.live = null
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
    if (event.kind === 'turn_end') this.setStatus(event.ok || event.interrupted ? 'idle' : 'failed')
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
