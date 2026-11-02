// Shared by the engine and the renderer: types and a few constants, no Node imports.

export type Column = 'backlog' | 'ready' | 'in_progress' | 'needs_you' | 'review' | 'done'

export type Phase =
  | 'not_started'
  | 'planning'
  | 'implementing'
  | 'testing'
  | 'reviewing'
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
  /** Push the ticket's branch and open a pull request when it reaches Review. Off unless the user turns it on. */
  openPrOnReview: boolean
}

/** A workspace's lineups. Only Change for now; M7 adds Investigate. */
export type Lineup = 'change'

/** The phases a role can put its ticket in while it is active. */
export const ROLE_PHASES = ['planning', 'implementing', 'testing', 'reviewing'] as const
export type RolePhase = (typeof ROLE_PHASES)[number]

export type ToolProfile = 'read_only' | 'edit'

/** What `report_problem` does: hand back to an earlier role, or ask the user. */
export type OnProblem = 'hand_back' | 'ask_me'

/** One role in a lineup; the roles work a ticket in turn, by position (1 first). */
export interface LineupRole {
  id: string
  workspaceId: string
  lineup: Lineup
  position: number
  name: string
  instructions: string
  activePhase: RolePhase
  onProblem: OnProblem
  /** The id of an earlier role in the same lineup to hand back to; null means the previous role. */
  handBackTo: string | null
  model: string | null
  effort: Effort | null
  toolProfile: ToolProfile
}

/**
 * A role as the lineup settings save it, in lineup order. An id from `lineup.get` keeps that role's identity;
 * any other id stands for a new role (which gets a fresh id), so `handBackTo` can point at it.
 */
export type LineupRoleInput = Omit<LineupRole, 'workspaceId' | 'lineup' | 'position'>

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
  /** The pull request Mainbus opened (or adopted) for the ticket's branch. */
  pr: PullRequest | null
  /** Why the last push or pull request failed; null once one succeeds. */
  prError: string | null
  createdAt: string
  updatedAt: string
}

export interface PullRequest {
  url: string
  number: number
}

export type DecisionAnswer =
  | { kind: 'option'; index: number; note?: string }
  | { kind: 'permission'; choice: 'allow_once' | 'always_allow' | 'deny'; note?: string }

/** Where the user answered a decision: its board card, the orchestrator panel, or the ticket's thread. */
export type AnsweredVia = 'board' | 'orchestrator' | 'thread'

export const ANSWERED_VIA: readonly AnsweredVia[] = ['board', 'orchestrator', 'thread']

/** How an answer's origin reads in a sentence: "from the board". */
export const ANSWERED_VIA_LABELS: Record<AnsweredVia, string> = {
  board: 'the board',
  orchestrator: 'the orchestrator panel',
  thread: 'the thread'
}

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
  /** `deferred`: the user put it off with Later…; it is still open, and returns to `pending` on its date. */
  status: 'pending' | 'deferred' | 'answered' | 'cancelled' | 'expired'
  /** The date a deferred decision comes back (from its hold); null while it isn't deferred. */
  deferredUntil: string | null
  answer: DecisionAnswer | null
  createdAt: string
  answeredAt: string | null
  /** Set with the answer: always the user so far. */
  answeredBy: 'user' | null
  answeredVia: AnsweredVia | null
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
  /** The user paused the active role: Resume continues it. Continue does not (it is for other pauses). */
  pausedByUser: boolean
  /** The earliest date a deferred decision of the ticket comes back; null when none is deferred (or one is pending). */
  deferredUntil: string | null
}

/** Where one role of a ticket run stands. `stopped` is a role whose run the user stopped. */
export type RoleStatus = 'not_started' | 'working' | 'waiting_on_you' | 'handed_off' | 'paused' | 'failed' | 'stopped'

/** One role in the ticket view's lineup strip. */
export interface StripRole {
  /** The role's id in its ticket run's snapshot (before the first run, in the workspace lineup). */
  id: string
  name: string
  status: RoleStatus
  /** True for the role whose agent run is open: at most one. */
  active: boolean
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
  /** Why the app couldn't open the intake pipe agents reach it through; absent while it listens. */
  intakeError?: string
}

/** What unattended mode is doing; the board header shows it next to the switch. */
export type UnattendedStatus =
  | { kind: 'off' }
  /** On, and about to pick the next Ready ticket. */
  | { kind: 'starting' }
  | { kind: 'working'; ticketNumber: number }
  /** On, with nothing to start: Ready is empty, or (`skipped`) no Ready ticket could be started. */
  | { kind: 'idle'; skipped?: true }
  /** On, and waiting for a ticket it did not start (by hand, or resumed alongside) to stop working. */
  | { kind: 'other_working'; ticketNumber: number }
  /** `until` is an ISO time. */
  | { kind: 'waiting'; ticketNumber: number; until: string }
  /** Turned itself off; `reason` says why. */
  | { kind: 'stopped'; reason: string }

export interface UnattendedState {
  on: boolean
  status: UnattendedStatus
}

/** Whether the GitHub CLI can open pull requests; `reason` says why not, without any of gh's own output. */
export type GhStatus = { ok: true } | { ok: false; reason: string }

export type ClaudeSetup =
  | { ok: true; path: string; version: string }
  | { ok: false; reason: 'not_found' | 'not_logged_in' | 'restart_required'; detail: string }

/** How a ticket is started. */
export interface StartOptions {
  /** The lineup roles to run, by id; they run in lineup order. Every role when absent. */
  roleIds?: string[]
  /**
   * The user's model and effort for this start, by role id; they beat the role's own setting. A role or field
   * left out resolves as usual (role setting, else the default table).
   */
  roles?: Record<string, { model?: string; effort?: Effort }>
  /** Added to every role's prompt in this run. */
  extraInstructions?: string
}

/** What a hold is on. Tickets for now; "Later…" on decisions uses the same table. */
export type HoldTarget = 'ticket' | 'decision'

/**
 * A hold the user put on a ticket: it isn't started by unattended mode or a start proposal while it is held. It
 * is released by hand, by starting the ticket by hand, or when `until` passes. A target has at most one unreleased hold.
 */
export interface Hold {
  id: string
  targetKind: HoldTarget
  targetId: string
  reason: string | null
  /** ISO date-time the hold ends by itself, or null for no date. */
  until: string | null
  createdBy: 'user'
  createdAt: string
  /** Null while held. */
  releasedAt: string | null
}

/** What the user chooses when holding a ticket. */
export interface HoldOptions {
  /** ISO date-time; absent for a hold with no date. Must be in the future. */
  until?: string
  reason?: string
}
