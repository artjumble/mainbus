import type { Effort } from '../../shared/domain'
import type { AgentEvent } from '../../shared/events'

/** What the in-process role tools (ask_user, handoff or submit_report, report_problem, report_waiting, check_criterion) call back into. */
export interface RoleToolHandlers {
  askUser(a: { question: string; options: string[]; recommended?: number }): Promise<string>
  handoff(a: { summary: string; notesForNext: string }): Promise<string>
  /** The last role of an Investigate lineup ends with this instead of handoff. */
  submitReport(a: { markdown: string }): Promise<string>
  reportProblem(a: { details: string }): Promise<string>
  /** `until` is an ISO date-time; the handler checks it, since the agent sends whatever it likes. */
  reportWaiting(a: { reason: string; until: string }): Promise<string>
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

/** What the orchestrator's read tools call back into: each answers with plain text for the agent. */
export interface OrchestratorReadToolHandlers {
  listWorkspaces(): Promise<string>
  listTickets(a: { column?: string }): Promise<string>
  getTicket(a: { number: number }): Promise<string>
  getRunStatus(a: { number: number }): Promise<string>
  getRecentEvents(a: { number: number; limit?: number }): Promise<string>
  listPendingDecisions(): Promise<string>
}

/**
 * Every Mainbus tool of the orchestrator: the read tools, and the propose tools, which store a proposal for the
 * user to decide and never change anything themselves. A propose tool validates its input itself, so it takes
 * whatever the agent sent.
 */
export interface OrchestratorToolHandlers extends OrchestratorReadToolHandlers {
  proposeCreateTickets(a: unknown): Promise<string>
  proposeStart(a: unknown): Promise<string>
  proposePause(a: unknown): Promise<string>
  proposeStop(a: unknown): Promise<string>
  proposeSkip(a: unknown): Promise<string>
  proposeHold(a: unknown): Promise<string>
  proposeAnswer(a: unknown): Promise<string>
  proposeRedirect(a: unknown): Promise<string>
  proposeReplace(a: unknown): Promise<string>
  proposePromote(a: unknown): Promise<string>
}

/** A role's `claude` process: its id, and the time just before it was spawned (ms since the epoch). */
export interface SpawnedClaude {
  pid: number
  spawnedAt: number
}

export interface RunSpec {
  kind?: 'role'
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
  /** The role ends with submit_report instead of handoff: the last role of an Investigate lineup. */
  endsWithReport?: boolean
  disallowedTools: string[]
  additionalDirectories: string[]
  resumeSessionId?: string
  roleTools: RoleToolHandlers
  onPermission(r: PermissionRequest): Promise<PermissionVerdict>
  /** Called when the run's `claude` process has started. */
  onProcessStart?(p: SpawnedClaude): void
  /** Called when the run's `claude` process has exited, whatever the reason. */
  onProcessExit?(p: SpawnedClaude): void
}

/**
 * The orchestrator's session: it reads (Read, Grep and Glob, and the Mainbus read tools) and proposes, and never
 * changes anything. No settings files are loaded, and its permission callback never raises a card.
 */
export interface OrchestratorRunSpec {
  kind: 'orchestrator'
  /** `<MAINBUS_HOME>\orchestrator`. */
  cwd: string
  prompt: string
  appendSystemPrompt: string
  model: string
  effort: Effort
  /** The workspace's repo, readable so it can draft good tickets. */
  additionalDirectories: string[]
  disallowedTools: string[]
  resumeSessionId?: string
  tools: OrchestratorToolHandlers
  /** Allows or denies at once: the orchestrator never waits on the user for a permission. */
  onPermission(r: PermissionRequest): Promise<PermissionVerdict>
}

export type AnyRunSpec = RunSpec | OrchestratorRunSpec

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
  start(spec: AnyRunSpec): Promise<RunHandle>
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
