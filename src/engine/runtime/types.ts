import type { Effort } from '../../shared/domain'
import type { AgentEvent } from '../../shared/events'

/** What the in-process role tools (ask_user, handoff, report_problem, check_criterion) call back into. */
export interface RoleToolHandlers {
  askUser(a: { question: string; options: string[]; recommended?: number }): Promise<string>
  handoff(a: { summary: string; notesForNext: string }): Promise<string>
  reportProblem(a: { details: string }): Promise<string>
  checkCriterion(a: { index: number }): Promise<string>
}

export interface PermissionRequest {
  toolName: string
  input: Record<string, unknown>
  reason?: string
  toolUseId: string
  signal: AbortSignal
}

export type PermissionVerdict = { allow: true } | { allow: false; message: string }

export interface RunSpec {
  /** The name of the lineup role the agent plays. The fake runtime can pick its script by it. */
  role?: string
  cwd: string
  /** The ticket's scratch folder: the agent's TEMP, TMP and TMPDIR point here. */
  tempDir: string
  ownBranch: string
  prompt: string
  appendSystemPrompt: string
  model?: string
  effort?: Effort
  toolProfile: 'read_only' | 'edit'
  disallowedTools: string[]
  additionalDirectories: string[]
  resumeSessionId?: string
  roleTools: RoleToolHandlers
  onPermission(r: PermissionRequest): Promise<PermissionVerdict>
}

export interface RunHandle {
  id: string
}

/** A one-shot summary, written by the model with no tools at all. */
export interface SummaryRequest {
  cwd: string
  /** The ticket's scratch folder, as for a run. */
  tempDir: string
  prompt: string
  /** The call is abandoned after this long. */
  timeoutMs: number
}

export interface AgentRuntime {
  start(spec: RunSpec): Promise<RunHandle>
  send(run: RunHandle, text: string): Promise<void>
  interrupt(run: RunHandle): Promise<void>
  stop(run: RunHandle): Promise<void>
  /** Ends when the process ends. */
  events(run: RunHandle): AsyncIterable<AgentEvent>
  /**
   * Answers `prompt` in one turn, through the same `claude` binary and login as the agents, with no tools.
   * Rejects on an error, an empty answer or the timeout.
   */
  summarize(req: SummaryRequest): Promise<string>
}

/** `start()` with a `resumeSessionId` rejects with this when the session cannot be resumed. */
export class ResumeFailedError extends Error {
  constructor(message = 'Could not resume the previous session') {
    super(message)
    this.name = 'ResumeFailedError'
  }
}
