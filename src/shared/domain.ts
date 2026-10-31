// Shared by the engine and the renderer: types only, no Node imports.

export type Column = 'backlog' | 'ready' | 'in_progress' | 'needs_you' | 'review' | 'done'

export type Phase =
  | 'not_started'
  | 'planning'
  | 'implementing'
  | 'testing'
  | 'waiting_on_you'
  | 'ready_for_review'
  | 'done'

export type AgentStatus =
  | 'queued'
  | 'working'
  | 'waiting_on_you'
  | 'handed_off'
  | 'paused'
  | 'failed'
  | 'replaced'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface Workspace {
  id: string
  name: string
  repoPath: string
  baseBranch: string
  slug: string
}

export interface Role {
  workspaceId: string
  name: string
  instructions: string
  activePhase: Phase
  toolProfile: 'read_only' | 'edit'
  model: string | null
  effort: Effort | null
}

/** Who wrote an intent entry when it was not the user: a local agent, by the name it reported (not verified). */
export interface IntentSource {
  kind: 'agent'
  agent: string
  /** The working directory of the CLI or MCP process that filed it. */
  cwd: string
}

export interface IntentEntry {
  text: string
  at: string // ISO time
  /** Absent on the user's own words (the New Ticket form, "Add to your words"). */
  source?: IntentSource
}

export interface Criterion {
  position: number
  text: string
  checked: boolean
}

export interface Ticket {
  id: string
  workspaceId: string
  number: number
  kind: 'change'
  title: string
  intent: IntentEntry[]
  spec: string
  criteria: Criterion[]
  labels: string[]
  manualColumn: 'backlog' | 'ready' | 'done'
  branch: string | null
  worktreePath: string | null
  createdAt: string
  updatedAt: string
}

export type DecisionAnswer =
  | { kind: 'option'; index: number; note?: string }
  | { kind: 'permission'; choice: 'allow_once' | 'always_allow' | 'deny'; note?: string }

export interface Decision {
  id: string
  ticketId: string
  agentRunId: string
  kind: 'question' | 'permission'
  question: string
  options: string[]
  recommended: number | null
  /** False for permission decisions where "Always allow" must not be offered (force-pushes). */
  allowAlways: boolean
  status: 'pending' | 'answered' | 'cancelled' | 'expired'
  answer: DecisionAnswer | null
  createdAt: string
  answeredAt: string | null
}

export interface AllowRule {
  id: string
  workspaceId: string
  toolName: string
  pattern: string | null
}

// Shared with the renderer, so they live here rather than in engine files
// (renderer typecheck must not pull in node:sqlite).
export interface TicketState {
  column: Column
  phase: Phase
  agentStatus: AgentStatus | null
  summary: string | null
  canContinue: boolean
}

export type NewTicketInput = {
  workspaceId: string
  title: string
  intent: string
  spec: string
  criteria: string[]
  labels: string[]
  column: 'backlog' | 'ready'
  /** Set only by agent intake: marks the first intent entry as agent-written. */
  source?: IntentSource
}

/** Never includes intent: intent is append-only. */
export type TicketPatch = Partial<{
  title: string
  spec: string
  criteria: Criterion[]
  labels: string[]
}>

/** How other agents on this machine run this app's `mainbus` CLI and MCP server. */
export interface AgentLauncher {
  /** stable: the mainbus.cmd that build-stable.ps1 writes. dev: Node on the bundle in out/cli. */
  kind: 'stable' | 'dev'
  /** The program and its leading arguments; `mcp` or `ticket ...` follows. */
  program: string[]
  /** What the CLI must share with this app to reach it: a MAINBUS_HOME override, if any. */
  env: Record<string, string>
  /** False when the launcher (or the dev bundle) isn't on disk yet. */
  exists: boolean
}

export type ClaudeSetup =
  | { ok: true; path: string; version: string }
  | { ok: false; reason: 'not_found' | 'not_logged_in' | 'restart_required'; detail: string }
