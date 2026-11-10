import type { ImageMime } from '../../shared/attachments'
import type { Effort } from '../../shared/domain'
import type { AgentEvent, ModelUsage, UsageEvent } from '../../shared/events'

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
  /** The session's live working folder when the tool was called (Claude Code's hook input), for the guard. */
  cwd?: string
  signal: AbortSignal
}

export type PermissionVerdict = { allow: true } | { allow: false; message: string }

/** What the orchestrator's read tools call back into: each answers with plain text for the agent. */
export interface OrchestratorReadToolHandlers {
  listWorkspaces(): Promise<string>
  /** Each of these takes an optional `workspace` (name or id); the focused one when left out. */
  listTickets(a: { workspace?: string; column?: string }): Promise<string>
  getTicket(a: { workspace?: string; number: number }): Promise<string>
  getRunStatus(a: { workspace?: string; number: number }): Promise<string>
  getRecentEvents(a: { workspace?: string; number: number; limit?: number }): Promise<string>
  listPendingDecisions(a: { workspace?: string }): Promise<string>
  /** Where time went: one ticket's (by number), or the workspace's last `last` tickets that reached Review (10 by default, at most 50). */
  getTimeReport(a: { workspace?: string; ticket?: number; last?: number }): Promise<string>
}

/**
 * Every Mainbus tool of the orchestrator: the read tools, and the propose tools, which store a proposal for the
 * user to decide and never change anything themselves. A propose tool validates its input itself, so it takes
 * whatever the agent sent.
 */
export interface OrchestratorToolHandlers extends OrchestratorReadToolHandlers {
  /** Creates tickets in a workspace's Backlog at once, at the user's request. */
  createTickets(a: unknown): Promise<string>
  /** Edits a ticket that hasn't started at the user's request: its title, spec, criteria and labels, and the user's own words appended. */
  updateTicket(a: unknown): Promise<string>
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
  proposeUpdateFromMain(a: unknown): Promise<string>
  proposeMerge(a: unknown): Promise<string>
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
  /** What the resumed session had used before, per model: the SDK's totals carry over, so the first turn is the difference. */
  usageBaseline?: Record<string, ModelUsage>
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
  /** Images the user sent with the first message, which go with the prompt. */
  promptImages?: PromptImage[]
  appendSystemPrompt: string
  model: string
  effort: Effort
  /** The workspace's repo, readable so it can draft good tickets. */
  additionalDirectories: string[]
  disallowedTools: string[]
  resumeSessionId?: string
  /** As for a role's run. */
  usageBaseline?: Record<string, ModelUsage>
  tools: OrchestratorToolHandlers
  /** Allows or denies at once: the orchestrator never waits on the user for a permission. */
  onPermission(r: PermissionRequest): Promise<PermissionVerdict>
}

export type AnyRunSpec = RunSpec | OrchestratorRunSpec

/** An image that goes into a user message as an image block: its type and its bytes, base64. */
export interface PromptImage {
  mime: ImageMime
  base64: string
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
  /** Called with what the call used, also when it failed. */
  onUsage?: (u: UsageEvent) => void
}

export interface AgentRuntime {
  start(spec: AnyRunSpec): Promise<RunHandle>
  /** A user message; `images` go into it as image blocks, before the text. */
  send(run: RunHandle, text: string, images?: PromptImage[]): Promise<void>
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
