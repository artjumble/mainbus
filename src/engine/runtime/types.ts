import type { Effort } from '../../shared/domain'
import type { AgentEvent } from '../../shared/events'

/** What the in-process role tools (ask_user, handoff) call back into. */
export interface RoleToolHandlers {
  askUser(a: { question: string; options: string[]; recommended?: number }): Promise<string>
  handoff(a: { summary: string; notesForNext: string }): Promise<string>
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

export interface AgentRuntime {
  start(spec: RunSpec): Promise<RunHandle>
  send(run: RunHandle, text: string): Promise<void>
  interrupt(run: RunHandle): Promise<void>
  stop(run: RunHandle): Promise<void>
  /** Ends when the process ends. */
  events(run: RunHandle): AsyncIterable<AgentEvent>
}

/** `start()` with a `resumeSessionId` rejects with this when the session cannot be resumed. */
export class ResumeFailedError extends Error {
  constructor(message = 'Could not resume the previous session') {
    super(message)
    this.name = 'ResumeFailedError'
  }
}
