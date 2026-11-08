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

/** The number of role agents that may run at once: its bounds and its default. */
export const AGENT_CAP_MIN = 1
export const AGENT_CAP_MAX = 10
export const AGENT_CAP_DEFAULT = 3

/** The app's global settings. */
export interface AppSettings {
  /** How many role agents may run at once; the orchestrator doesn't count. */
  maxAgents: number
  /** What closing the window does: keep running in the tray while agents are open, or always quit. */
  whenClosed: WhenClosed
  /** "Theme": the theme the app is drawn in, and with Match Windows the light and dark theme it switches between. */
  theme: ThemeSetting
}

export type WhenClosed = 'tray' | 'quit'
export const WHEN_CLOSED_DEFAULT: WhenClosed = 'tray'

export type ThemeScheme = 'light' | 'dark'

/**
 * The built-in themes, in the order the setting lists them. Each one's colours are in the renderer's theme.ts, which
 * must have an entry for every id here; the scheme drives Mantine's colour scheme, nativeTheme and the window frame.
 * The ground is here, not there, because the main process paints the window with it before the page loads, so there is
 * no flash of another colour on launch. Adding a theme is one row here, its entry in theme.ts, and their tests.
 */
export const THEMES = [
  { id: 'light', name: 'Light', scheme: 'light', ground: '#F4F4F1' },
  { id: 'dark', name: 'Dark', scheme: 'dark', ground: '#1E1E1C' },
  { id: 'night-owl', name: 'Night Owl', scheme: 'dark', ground: '#011627' },
  { id: 'light-owl', name: 'Light Owl', scheme: 'light', ground: '#F0F0F0' }
] as const satisfies readonly { id: string; name: string; scheme: ThemeScheme; ground: string }[]

export type ThemeId = (typeof THEMES)[number]['id']
export type ThemeInfo = (typeof THEMES)[number]
export const THEME_IDS: readonly ThemeId[] = THEMES.map((t) => t.id)

/** The page ground of each theme. */
export const GROUND = Object.fromEntries(THEMES.map((t) => [t.id, t.ground])) as { [T in ThemeInfo as T['id']]: T['ground'] }

export function isThemeId(v: unknown): v is ThemeId {
  return THEME_IDS.includes(v as ThemeId)
}

export function themeOf(id: ThemeId): ThemeInfo {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

/** A theme by id, or 'system' (Match Windows, following it while the app runs). Light until the user picks. */
export type ThemeChoice = ThemeId | 'system'
export const THEME_CHOICES: readonly ThemeChoice[] = [...THEME_IDS, 'system']
export const THEME_DEFAULT: ThemeChoice = 'light'

/** The Theme setting: the choice, and the light and the dark theme Match Windows uses. */
export interface ThemeSetting {
  choice: ThemeChoice
  light: ThemeId
  dark: ThemeId
}
export const THEME_SETTING_DEFAULT: ThemeSetting = { choice: THEME_DEFAULT, light: 'light', dark: 'dark' }

/** The theme a Theme setting draws the app in now: Match Windows takes its light or dark pick, as Windows is. */
export function resolveTheme(setting: ThemeSetting, systemDark: boolean): ThemeId {
  if (setting.choice !== 'system') return setting.choice
  return systemDark ? setting.dark : setting.light
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface Workspace {
  id: string
  name: string
  repoPath: string
  baseBranch: string
  slug: string
  /** Push the ticket's branch and open a pull request when it reaches Review. Off unless the user turns it on. */
  openPrOnReview: boolean
  /** "Save investigation reports in the repo": Mainbus commits an Investigate ticket's report on its branch. On unless the user turns it off. */
  saveReports: boolean
  /** The folder, relative to the repo, investigation reports are saved in (see reportsFolderProblem). */
  reportsFolder: string
  /** The command Mainbus runs in each new ticket folder before the first role starts; empty for none (the default). */
  setupCommand: string
  /** How long the setup command may run, in minutes (SETUP_TIMEOUT_MIN to SETUP_TIMEOUT_MAX). */
  setupTimeoutMinutes: number
}

export const SETUP_TIMEOUT_DEFAULT = 15
export const SETUP_TIMEOUT_MIN = 1
export const SETUP_TIMEOUT_MAX = 60
export const SETUP_COMMAND_MAX = 1000

/** The two settings of the ticket-folder setup step; either can be left out. */
export interface SetupSettingsInput {
  command?: string
  timeoutMinutes?: number
}

/** The setup command as Mainbus stores it (trimmed, one line), or why it is refused. Empty means no setup. */
export function checkSetupCommand(input: string): { ok: true; command: string } | { ok: false; reason: string } {
  const command = input.trim()
  if (/[\r\n]/.test(command)) return { ok: false, reason: 'The setup command must be one line' }
  if (command.length > SETUP_COMMAND_MAX) return { ok: false, reason: `The setup command can be at most ${SETUP_COMMAND_MAX} characters` }
  return { ok: true, command }
}

export function checkSetupTimeout(minutes: number): { ok: true; minutes: number } | { ok: false; reason: string } {
  if (!Number.isInteger(minutes) || minutes < SETUP_TIMEOUT_MIN || minutes > SETUP_TIMEOUT_MAX) {
    return { ok: false, reason: `The timeout must be a whole number of minutes from ${SETUP_TIMEOUT_MIN} to ${SETUP_TIMEOUT_MAX}` }
  }
  return { ok: true, minutes }
}

/**
 * What the workspace's setup command did in a ticket's folder. pending: not run yet, or interrupted (it runs before the
 * next role starts); failed: a non-zero exit or a timeout; skipped: the user chose to start without it.
 */
export interface TicketSetup {
  state: 'pending' | 'succeeded' | 'failed' | 'skipped'
  command: string
  exitCode: number | null
  timedOut: boolean
  /** The last lines of the command's output, for the role prompt after a failure. */
  tail: string
}

/** The two settings of saving investigation reports in the repo; either can be left out. */
export interface ReportSettingsInput {
  saveReports?: boolean
  reportsFolder?: string
}

export const REPORTS_FOLDER_DEFAULT = 'docs/investigations'

/**
 * The reports folder as Mainbus stores it (forward slashes, no `.` segments, no trailing slash), or why it is refused:
 * it must be a relative path that stays inside the repo, and outside `.git`.
 */
export function checkReportsFolder(input: string): { ok: true; folder: string } | { ok: false; reason: string } {
  const text = input.trim().replace(/\\/g, '/')
  if (text === '') return { ok: false, reason: 'Give a folder inside the repository, such as docs/investigations' }
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) {
    return { ok: false, reason: 'The folder must be relative to the repository, such as docs/investigations, not a full path' }
  }
  // Control characters and the ones Windows refuses in a file name.
  if (/[\u0000-\u001f<>:"|?*]/.test(text)) return { ok: false, reason: 'The folder has a character a folder name can\'t have' }
  const segments = text.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.includes('..')) return { ok: false, reason: 'The folder must stay inside the repository: ".." leaves it' }
  if (segments.some((s) => s.toLowerCase() === '.git')) return { ok: false, reason: "The folder can't be inside .git" }
  if (segments.some((s) => /[ .]$/.test(s))) return { ok: false, reason: "A folder name can't end with a space or a dot" }
  if (segments.length === 0) return { ok: false, reason: 'Give a folder inside the repository, such as docs/investigations' }
  return { ok: true, folder: segments.join('/') }
}

/** A workspace's lineups: Change tickets run the Change lineup, Investigate tickets the Investigate one. */
export type Lineup = 'change' | 'investigate'
export const LINEUPS: readonly Lineup[] = ['change', 'investigate']

/** What a ticket is for; it picks the lineup the ticket runs. */
export type TicketKind = Lineup

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
  /**
   * On the first entry only: the orchestrator created the ticket at the user's request, without a card. The words are
   * still the user's own.
   */
  via?: 'orchestrator'
}

/** A later message of the user's that belongs to the same request, verbatim, with when they sent it. */
export interface IntentAddition {
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
  kind: TicketKind
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
  /** The markdown report an Investigate ticket's last role submitted; null until then. On a Change ticket, the investigation report it was promoted from. */
  report: string | null
  /**
   * Where Mainbus saves an Investigate ticket's report on its branch: the repo-relative path, chosen at the first save
   * and kept, so a resubmitted report overwrites it. Null until a save is tried (or on any other ticket).
   */
  reportFile: string | null
  /** The commit that saved the report's latest version; null until one does, or while the latest save failed. */
  reportCommit: string | null
  /** Why the latest save of the report to the repo failed; null once one succeeds. The report itself is kept either way. */
  reportFileError: string | null
  /** The id of the Investigate ticket this Change ticket was promoted from; null for any other ticket. */
  promotedFrom: string | null
  /** The run settings the user saved for the ticket's starts; null means the lineup's defaults. */
  runSettings: RunSettings | null
  /** The workspace's setup command in this ticket's folder; null when none applies. */
  setup: TicketSetup | null
  createdAt: string
  updatedAt: string
}

/**
 * A ticket's saved run settings: which roles run, the model and effort the user chose per role, and extra
 * instructions. Every start that doesn't choose its own uses them; they stay for the next start after a run ends.
 */
export interface RunSettings {
  /** The lineup roles that don't run, by id: a role added to the lineup later runs. */
  excludedRoleIds: string[]
  /** The model and effort the user chose, by role id; a role or field left out resolves as usual. */
  roles: Record<string, { model?: string; effort?: Effort }>
  /** Added to every role's prompt; null for none. */
  extraInstructions: string | null
  /** The names of the roles above when saved, so one that has since left the lineup can still be named. */
  roleNames: Record<string, string>
}

/** Run settings as the ticket view saves them; the engine fills in the role names. */
export type RunSettingsInput = Omit<RunSettings, 'roleNames' | 'extraInstructions'> & { extraInstructions: string }

export interface PullRequest {
  url: string
  number: number
}

export type DecisionAnswer =
  | { kind: 'option'; index: number; note?: string }
  | { kind: 'permission'; choice: 'allow_once' | 'always_allow' | 'deny'; note?: string }
  /** The user's message settled the question: the text is the message, which the agent received as such. */
  | { kind: 'message'; text: string }

/** The places a decision's card is answered from: the board, the orchestrator panel, or the ticket's thread. */
export type CardVia = 'board' | 'orchestrator' | 'thread'

/** Where the user answered a decision: one of its cards, or a message to the ticket. */
export type AnsweredVia = CardVia | 'message'

/** The places a card can be answered from; a message is not one (the engine settles by message itself). */
export const ANSWERED_VIA: readonly CardVia[] = ['board', 'orchestrator', 'thread']

/** How an answer's origin reads in a sentence: "from the board", "in a message". */
export const ANSWERED_VIA_PHRASES: Record<AnsweredVia, string> = {
  board: 'from the board',
  orchestrator: 'from the orchestrator panel',
  thread: 'from the thread',
  message: 'in a message'
}

/** What a permission request asked for, kept apart from the question text so a card can show the command as code. */
export interface PermissionRequestParts {
  role: string
  tool: string
  /** The command of a shell tool (Bash, PowerShell). */
  command: string | null
  /** The file a file tool works on. */
  path: string | null
  /** The input of a tool that is not a shell tool. */
  input: Record<string, unknown> | null
  reason: string | null
}

export interface Decision {
  id: string
  ticketId: string
  agentRunId: string
  kind: 'question' | 'permission'
  question: string
  /** The parts of a permission request; null for questions and for permissions asked before they were kept. */
  request: PermissionRequestParts | null
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
  /** Only while the agent is Queued: its place in the queue for a slot, 1 first. */
  queuePosition?: number
  /** The usage limit paused the agent: Mainbus resumes it at the reset, or the user's Resume does it early. `summary` says why. */
  pausedByLimit?: boolean
  /** Mainbus is running the workspace's setup command in the ticket's folder; no role has started yet. */
  settingUp?: boolean
}

/** Where one role of a ticket run stands. `stopped` is a role whose run the user stopped. */
export type RoleStatus = 'not_started' | 'queued' | 'working' | 'waiting_on_you' | 'handed_off' | 'paused' | 'failed' | 'stopped'

/** One role in the ticket view's lineup strip. */
export interface StripRole {
  /** The role's id in its ticket run's snapshot (before the first run, in the workspace lineup). */
  id: string
  name: string
  status: RoleStatus
  /** True for the role whose agent run is open: at most one. */
  active: boolean
  /** How many of the role's agents were replaced in this ticket run. */
  replacements: number
  /** Only while the role is Queued: its place in the queue for a slot, 1 first. */
  queuePosition?: number
}

export type NewTicketInput = {
  workspaceId: string
  title: string
  intent: string
  spec: string
  criteria: string[]
  labels: string[]
  column: 'backlog' | 'ready'
  /** Absent means change. */
  kind?: TicketKind
  /** Set only by agent intake: marks the first intent entry as agent-written. */
  source?: IntentSource
  /** The user's later messages of the same request, appended after `intent` as entries of their own. */
  intentAdded?: IntentAddition[]
  /** An agent's summary of what led to the ticket: stored as an intent entry of its own, with its source, after the user's words. */
  agentContext?: { text: string; source: IntentSource }
  /** Set only when the orchestrator created it directly: marks the first intent entry. */
  via?: 'orchestrator'
  /** The user asked the orchestrator to propose starting the ticket once it is in Ready (now, if it was created there). */
  startWhenReady?: boolean
  /** Tickets (by id) that block it; checked by the engine, which refuses a cycle. */
  blockedBy?: string[]
}

/** Never includes intent: intent is append-only. */
export type TicketPatch = Partial<{
  title: string
  spec: string
  criteria: Criterion[]
  labels: string[]
}>

/** The fields the orchestrator can edit, in the order they are listed. */
export type EditedField = 'title' | 'spec' | 'criteria' | 'labels' | 'blockedBy'

/** The values of the edited fields, before or after an edit; only the changed ones are present. */
export type EditedValues = Partial<{ title: string; spec: string; criteria: Criterion[]; labels: string[]; blockedBy: number[] }>

/**
 * One edit the orchestrator made to a ticket at the user's request, kept so the panel can show it and Undo it.
 * `intentAdded` are the user's own messages it appended, exactly as stored.
 */
export interface TicketEdit {
  id: string
  ticketId: string
  workspaceId: string
  number: number
  at: string
  fields: EditedField[]
  before: EditedValues
  after: EditedValues
  intentAdded: IntentEntry[]
  /** The ticket's updatedAt right after the edit: Undo is refused once the ticket changed. */
  ticketUpdatedAt: string
  undoneAt: string | null
}

/** An edit as the board ticket carries it, for the ticket's Activity. */
export interface TicketEditNote {
  id: string
  at: string
  fields: EditedField[]
  /** How many of the user's messages it appended. */
  userWords: number
  undoneAt: string | null
}

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

/**
 * Where the whole app stands on the usage limit. `limited`: every working agent is paused until `resetsAt` (null when
 * unknown: Mainbus then tries again at `retryAt`). `warning`: a window is nearly used up, so new agents wait as Queued.
 */
export type UsageState =
  | { kind: 'ok' }
  | { kind: 'warning'; resetsAt: string | null }
  | { kind: 'limited'; resetsAt: string | null; retryAt: string | null; paused: number }

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
  /** The user chose to start although a blocker isn't Done yet; the start is recorded in Activity. */
  startAnyway?: boolean
}

/** A ticket that blocks another: it is satisfied once it is Done. */
export interface Blocker {
  id: string
  number: number
  title: string
  done: boolean
}

/** What happened with a ticket's blockers, for its Activity and the orchestrator. */
export interface DependencyNote {
  id: string
  at: string
  kind: 'unblocked' | 'started_blocked'
  blockers: { number: number; title: string }[]
  /** How a start-anyway was asked for; null for unblocked. */
  via: 'ticket' | 'proposal' | null
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

/** How far a ticket's branch is from the newest base: what the board's freshness chips and the ticket view show. */
export interface BranchFreshness {
  /** The workspace's base branch, by name. */
  baseBranch: string
  /** The ref compared against: origin/<base> when that is ahead of the local base, else the local base. */
  base: string
  /** Commits on the newest base that the branch doesn't have. */
  behind: number
  /** Files that would conflict if the newest base were merged into the branch; empty when it merges cleanly. */
  conflicts: string[]
  checkedAt: string
  /** Why the newest base couldn't be fetched, or null. */
  fetchError: string | null
}

/** What the stuck detector looks for. */
export type StuckRule = 'repeated_failure' | 'no_progress' | 'silence' | 'no_milestone' | 'long_turn' | 'dead_process'

/** A stuck episode as the board and the ticket view show it. */
export interface StuckEpisode {
  id: string
  agentRunId: string
  /** The rule of the latest hit. */
  rule: StuckRule
  /** What the detector saw, one line each. */
  evidence: string[]
  hitCount: number
  /** True from the third hit: the evidence asks for a closer look. */
  needsCloserLook: boolean
  openedAt: string
  lastHitAt: string
  /** When the episode reached its escalation count, or null. */
  escalatedAt: string | null
  /** When a redirect was delivered for this episode, or null. An episode is redirected once. */
  redirectedAt: string | null
}

/** A wait an agent declared with report_waiting: the stuck detector expects silence until `until`. */
export interface DeclaredWait {
  reason: string
  /** ISO date-time. */
  until: string
}
