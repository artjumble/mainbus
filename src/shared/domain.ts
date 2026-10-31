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

export interface IntentEntry {
  text: string
  at: string // ISO time
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
}

/** Never includes intent: intent is append-only. */
export type TicketPatch = Partial<{
  title: string
  spec: string
  criteria: Criterion[]
  labels: string[]
}>

export type ClaudeSetup =
  | { ok: true; path: string; version: string }
  | { ok: false; reason: 'not_found' | 'not_logged_in' | 'restart_required'; detail: string }
