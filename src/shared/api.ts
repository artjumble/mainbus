// Shared by the engine, the preload and the renderer: no Node imports (the renderer typechecks this file).
// Mostly types; the channel names and error name at the bottom are the only runtime values.
import type { Attachment } from './attachments'
import type {
  AgentLauncher,
  AllowRule,
  Blocker,
  DependencyNote,
  AppSettings,
  BaseTestsView,
  CardVia,
  ClaudeSetup,
  Decision,
  DecisionAnswer,
  GhStatus,
  Hold,
  HoldOptions,
  Lineup,
  LineupPreset,
  LineupPresetInput,
  LineupRole,
  LineupRoleInput,
  NewTicketInput,
  ReportSettingsInput,
  SetupSettingsInput,
  RunSettingsInput,
  StartOptions,
  StripRole,
  TestCommand,
  BranchFreshness,
  StuckEpisode,
  Ticket,
  TicketEdit,
  TicketEditNote,
  TicketPatch,
  ThemeChoice,
  ThemeId,
  ThemeScheme,
  ThemeSetting,
  TicketState,
  UnattendedState,
  UsageState,
  WhenClosed,
  Workspace
} from './domain'
import type { TicketTime, WorkspaceTimeReport } from './timeBreakdown'
import type { UsageTotals } from './usageTotals'
import type { MergeMethod, MergeOptions, MergeOutcome, MergePlan, MergePreview } from './merge'
import type { OrchestratorStatus, OrchestratorThread, StoredEvent, ThreadRun } from './events'
import type { Proposal } from './proposals'

/** Whether a chosen folder can open as a workspace, and if not, why.  is the repository root (the folder itself when there is no repository). */
export interface FolderReadiness {
  status: 'ready' | 'not_a_repo' | 'no_commits' | 'detached_head'
  folder: string
  root: string
}

/** Something in the folder worth a second look before it is committed. */
export interface SetupWarning {
  kind: 'secret' | 'generated' | 'large'
  path: string
  files: number
  bytes: number
}

/** What a first commit of the folder's files would include. */
export interface SetupPreview {
  root: string
  files: number
  bytes: number
  /** One per top-level name, sorted. */
  entries: { name: string; folder: boolean; files: number; bytes: number }[]
  warnings: SetupWarning[]
}

export interface PrepareOptions {
  /** Commit the folder's files (true) or make an empty commit (false). */
  commitFiles: boolean
  /** Append the warned-about items to .gitignore first; only with commitFiles. */
  writeGitignore?: boolean
}

/** An open workspace with what the rail shows beside its name. */
export type WorkspaceSummary = Workspace & {
  /** An agent is working in it (or queued, or about to resume after a restart). */
  active: boolean
  /** How many of its tickets are in Needs you. */
  needsYou: number
  /** Agents working, waiting on you, and open but paused or queued: what the rail's status line and the Fleet line count. */
  working: number
  waiting: number
  idle: number
}

/**
 * A ticket as the board shows it: its state, and its lineup strip (the latest ticket run's roles, or the
 * workspace lineup before the first run). `skipTo` names the role Skip to next role would start: null when no
 * role is active, or when the active role is the last.
 */
export type BoardTicket = Ticket & {
  state: TicketState
  lineup: StripRole[]
  skipTo: string | null
  /** The ticket's open decisions, oldest first: the card's Answer control answers the first. */
  pendingDecisions: Decision[]
  /** The decisions the user put off with Later…, oldest first. */
  deferredDecisions: Decision[]
  /** The user's hold on the ticket, or null. */
  hold: Hold | null
  /** The open stuck episode of the ticket's open run, or null. */
  stuck: StuckEpisode | null
  /** The images the user attached, oldest first. */
  attachments: Attachment[]
  /** What was dropped from the saved run settings because the lineup changed since, one sentence each. */
  runSettingsNotices: string[]
  /** The edits the orchestrator made to it at the user's request, oldest first (the ticket's Activity). */
  edits: TicketEditNote[]
  /** The tickets that block it, by number; empty when none. */
  blockedBy: Blocker[]
  /** When it was unblocked, or started while blocked, oldest first (the ticket's Activity). */
  dependencyNotes: DependencyNote[]
  /** How far its branch is behind the newest base, and whether merging it would conflict; null when not checked (no branch, or Done). */
  freshness: BranchFreshness | null
}

/** An image to attach to a ticket being created: its name as given and its bytes. */
export interface NewAttachment {
  name: string
  bytes: Uint8Array
}

/**
 * What the engine pushes to the renderer. Partial (streaming) thread events carry seq 0: they are never stored.
 * A thread event comes with the run it belongs to.
 */
export type EngineEvent =
  | { type: 'board.changed'; workspaceId: string }
  /** The workspace's base-branch test run started, progressed, finished, or is waiting for agents to finish. */
  | { type: 'baseTests.changed'; workspaceId: string }
  | { type: 'thread.appended'; workspaceId: string; ticketId: string; event: StoredEvent; run: ThreadRun }
  | { type: 'decision.changed'; workspaceId: string; decision: Decision }
  | { type: 'unattended.changed'; workspaceId: string; state: UnattendedState }
  /** A workspace was opened, focused or removed; `focusedId` is the one the board shows now. */
  | { type: 'workspaces.changed'; focusedId: string | null }
  | { type: 'usage.changed'; state: UsageState }
  /** An event of the orchestrator's thread; partial ones carry seq 0, as in a ticket's thread. */
  | { type: 'orchestrator.appended'; event: StoredEvent }
  | { type: 'orchestrator.status'; status: OrchestratorStatus }
  /** A proposal was made, decided, carried out or failed. */
  | { type: 'proposal.changed'; proposal: Proposal }
  /** The orchestrator edited a ticket, or the edit was undone. */
  | { type: 'ticketEdit.changed'; edit: TicketEdit }
  /** The Theme setting changed: the window and the page switch theme without a restart. */
  | { type: 'theme.changed'; theme: ThemeSetting }

/** Every command the renderer can send to the engine. A thrown error reaches the renderer as a rejected promise. */
export interface EngineCommands {
  'setup.check'(): ClaudeSetup
  /** The focused workspace: the one the board shows; null when none is open. */
  'workspace.get'(): Workspace | null
  /** Every open workspace, oldest first. */
  'workspace.list'(): Workspace[]
  /**
   * Every open workspace, oldest first, with what the rail shows: whether an agent is working in it and how many of its
   * tickets need you. Read from stored state, so it is right at launch before agents are back.
   */
  'workspace.summaries'(): WorkspaceSummary[]
  /**
   * Opens the repository (detecting the base branch with `git symbolic-ref --short HEAD`) as a workspace and focuses it.
   * A repo that is open already is returned as it is, and focused.
   */
  'workspace.open'(repoPath: string): Workspace
  /** Whether the folder can open as a workspace, and if not, why (a rejection carries only text, so the reason comes here). */
  'workspace.check'(repoPath: string): FolderReadiness
  /**
   * What a first commit of the folder's files would include: counts, top-level entries, and warnings for likely secrets
   * and large or generated folders. Only for a folder without a repository or without commits. Changes nothing.
   */
  'workspace.previewSetup'(repoPath: string): SetupPreview
  /**
   * After the user confirmed:  when there is no repository, a first commit (of the files, or empty), then opens
   * the workspace. A missing git identity or a detached HEAD is refused with what to run. Never sets git's configuration,
   * adds a remote or pushes. Only the renderer can reach it: the agent intake has no way to make Mainbus commit.
   */
  'workspace.prepare'(repoPath: string, options: PrepareOptions): Workspace
  /** Makes the workspace the focused one, which is remembered. Unknown or removed ids are refused. */
  'workspace.focus'(id: string): Workspace
  /**
   * Removes the workspace from Mainbus; never deletes the repo. Refused while any of its agents is open, or while a ticket's
   * folder has uncommitted changes. `keptFolders` are ticket folders that could not be removed and were left as they are.
   */
  'workspace.remove'(id: string): { keptFolders: string[] }
  /**
   * The switch "Open a PR when a ticket reaches Review". Like Retry below, only the renderer can reach it:
   * the agent intake (pipe, CLI, MCP) has no way to make Mainbus push.
   */
  'workspace.setOpenPrOnReview'(on: boolean, workspaceId?: string): Workspace
  /** How Merge… merges a pull request: a merge commit (the default), a squash or a rebase. Renderer only, like the switch above. */
  'workspace.setMergeMethod'(method: MergeMethod, workspaceId?: string): Workspace
  /**
   * "Save investigation reports in the repo" and its folder; what is left out stays as it is. A folder that leaves the
   * repo is refused with the reason. Like the switch above, only the renderer can reach it.
   */
  'workspace.setReportSettings'(settings: ReportSettingsInput, workspaceId?: string): Workspace
  /**
   * The setup command Mainbus runs in each new ticket folder, and its timeout in minutes; what is left out stays as it is.
   * A command with a line break, or a timeout outside 1 to 60, is refused with the reason. The command runs outside the
   * agents' permissions, so only the renderer can reach this.
   */
  'workspace.setSetupSettings'(settings: SetupSettingsInput, workspaceId?: string): Workspace
  /**
   * The workspace's test commands, run on the newest base branch to learn which failures are already there; an empty list
   * turns that off. A refused list throws with the reason. The commands run outside the agents' permissions, so only the
   * renderer can reach this.
   */
  'workspace.setTestCommands'(commands: TestCommand[], workspaceId?: string): Workspace
  /** The last base-branch test run, its known failures, and whether a run is under way or waiting for agents to finish. */
  'workspace.baseTests'(workspaceId?: string): BaseTestsView
  /** Runs the test commands on the newest base branch now, whatever the agents are doing; returns once the run is queued. Renderer only. */
  'workspace.runBaseTests'(workspaceId?: string): void
  /** Whether the GitHub CLI is installed and signed in; never any of its output. */
  'github.check'(workspaceId?: string): GhStatus
  /** The tickets of the workspace (the focused one unless given). */
  'board.get'(workspaceId?: string): { tickets: BoardTicket[] }
  /**
   * The user's own ticket: a source can only come in through agent intake. `attachments` are images to attach to it,
   * checked before the ticket is created: one that can't be attached creates nothing.
   */
  'ticket.create'(
    i: Omit<NewTicketInput, 'workspaceId' | 'source' | 'via' | 'intentAdded' | 'agentContext' | 'runSettings'> & {
      attachments?: NewAttachment[]
      /** The name of one of the workspace's presets: the ticket starts with its run settings. Refused for an unknown name or an Investigate ticket. */
      preset?: string
    },
    workspaceId?: string
  ): Ticket
  /**
   * Attaches an image to the ticket: a PNG, JPEG, GIF or WebP (by its leading bytes), at most 10 MB, at most 20 per
   * ticket; anything else is refused with a plain reason. A ticket's working agent is told in a message. Only the renderer can reach these.
   */
  'attachment.add'(ticketId: string, name: string, bytes: Uint8Array): Attachment
  /** Removes the attachment and its file; a ticket's working agent is told. Nothing happens when it is already gone. */
  'attachment.remove'(id: string): void
  /** The ticket's attachments, oldest first. */
  'attachment.list'(ticketId: string): Attachment[]
  /** The image as a data URL: the renderer's only way to an attachment's file. */
  'attachment.data'(id: string): string
  'ticket.update'(id: string, p: TicketPatch): Ticket
  /** Replaces the ticket's blockers (ids of tickets in its workspace) at any time; a cycle or another workspace's ticket is refused. Only the renderer can reach it. */
  'ticket.setBlockedBy'(id: string, blockerIds: string[]): Ticket
  'ticket.appendIntent'(id: string, text: string): Ticket
  /**
   * Puts every field the orchestrator's edit changed back as it was, and removes the intent entries that edit appended.
   * Refused, with the reason, when the ticket changed or started since, or the edit is already undone. Only the renderer can reach it.
   */
  'ticket.undoEdit'(editId: string): TicketEdit
  /** Moving to done can answer 'dirty': the worktree has uncommitted work and the ticket stays where it was. */
  'ticket.move'(id: string, c: 'backlog' | 'ready' | 'done'): 'moved' | 'dirty' | 'asked'
  /**
   * Holds the ticket, optionally until a date (ISO, in the future): unattended mode and start proposals leave it
   * alone. It doesn't touch a running agent. A held ticket keeps its hold and takes the new date and reason.
   */
  'ticket.hold'(id: string, opts?: HoldOptions): Hold
  /** Releases the ticket's hold; nothing happens when it has none. */
  'ticket.unhold'(id: string): void
  /**
   * Saves the run settings every start of the ticket uses unless it chooses its own; null clears them, back to the
   * lineup's defaults. Only while the ticket is in Backlog or Ready with no run open.
   */
  'ticket.setRunSettings'(id: string, settings: RunSettingsInput | null): Ticket
  /**
   * The title and spec the Promote dialog starts with for an Investigate ticket's report: the ticket's title and a
   * spec drafted from the report (`drafted`), or the report itself when that failed. Refuses a ticket that can't be promoted.
   */
  'ticket.draftPromotion'(id: string): { title: string; spec: string; drafted: boolean }
  /**
   * Promotes the Investigate ticket's report: a new Change ticket in Ready with the same intent, this title and
   * spec, and the report attached; the original moves to Done. Changes nothing if the original can't move to Done.
   */
  'ticket.promote'(id: string, fields: { title: string; spec: string }): Ticket
  /** Retry: pushes the branch of a ticket in Review again and opens its PR if it has none. Never forces. */
  'ticket.openPr'(id: string): void
  /**
   * "Save report to repo": writes and commits an Investigate ticket's report in Review again, after a failure, then
   * pushes and opens its PR when the workspace asks for that. Only the renderer can reach it.
   */
  'ticket.saveReport'(id: string): void
  /**
   * "Run setup again": runs the workspace's setup command in the ticket's folder, while no role is working. The result
   * lands in the ticket's thread. Only the renderer can reach it.
   */
  'ticket.runSetup'(id: string): void
  /**
   * "Update from main": ends the ticket's open run, if any, and starts an Implementer-only run that merges the newest base
   * into the branch. Refused unless the branch is behind and no role is working. Only the renderer can reach it.
   */
  'ticket.updateFromMain'(id: string): void
  /**
   * What Merge… would do to a ticket in Review, or why it can't: through its pull request on GitHub, or, with no remote or
   * no pull request, into the local base branch. Changes nothing. Only the renderer can reach it.
   */
  'ticket.mergePreview'(id: string): MergePreview
  /**
   * Merge…: merges the ticket's pull request (gh, the workspace's merge method) or its branch into the local base, then
   * moves it to Done unless `moveToDone` is false. Works the plan out again and refuses, changing nothing, if it differs
   * from `expect`, the one the user saw. Only the renderer can reach it, and the orchestrator can only propose it.
   */
  'ticket.merge'(id: string, opts: MergeOptions & { expect: MergePlan }): MergeOutcome
  /** Where the ticket's time went, per run and role, from its stored events. */
  'ticket.time'(ticketId: string): TicketTime
  /**
   * Where time went over the workspace's tickets that reached Review: the newest `last` (10, 25 or 50), or those between
   * the days `since` and `until` (YYYY-MM-DD).
   */
  'workspace.timeReport'(opts: { last?: number; since?: string; until?: string }, workspaceId?: string): WorkspaceTimeReport
  /** Every run of the ticket, oldest first: their events, and the runs themselves (for each event's role). */
  'thread.get'(ticketId: string): { events: StoredEvent[]; decisions: Decision[]; runs: ThreadRun[] }
  /**
   * Runs the ticket through its lineup, as a new ticket run. `roleIds` picks the roles to run (in lineup order);
   * without it every role runs. Rejects an empty list or an id that isn't in the lineup.
   */
  'agent.start'(ticketId: string, opts?: StartOptions): void
  'agent.send'(ticketId: string, text: string): void
  'agent.stop'(ticketId: string): void
  'agent.continue'(ticketId: string): void
  /** Interrupts the active role and stops its process; the run stays open, Paused, until Resume. */
  'agent.pause'(ticketId: string): void
  /** Resumes a role the user paused, in the same session, with "Continue.". */
  'agent.resume'(ticketId: string): void
  /**
   * Ends the active role as handed off, with a handoff summary Mainbus generates from its log, and starts the
   * next ticked role; on the last role the ticket goes to Review. Like Pause and Resume, only the renderer can reach it.
   */
  'agent.skip'(ticketId: string): void
  /** Answers a pending decision from `via`; a decision already answered (from anywhere) is refused and nothing is delivered. */
  'decision.answer'(id: string, a: DecisionAnswer, via: CardVia): void
  /**
   * Later…: puts a pending decision off until `until` (ISO, in the future) through a hold on it. It leaves Needs you
   * and can still be answered; on its date it is pending again. Refuses a decision that isn't pending.
   */
  'decision.defer'(id: string, until: string): Decision
  /** Brings a deferred decision back now; refuses one that isn't deferred. */
  'decision.bringBack'(id: string): void
  /** The workspace's lineup of that kind (Change unless given), first role first. */
  'lineup.get'(lineup?: Lineup, workspaceId?: string): LineupRole[]
  /**
   * Replaces the whole lineup of that kind (Change unless given), in order. Rejects, with a message for the settings screen, a lineup with no
   * roles, an empty or duplicate name, or a hand-back to a role that isn't earlier in the lineup.
   */
  'lineup.save'(roles: LineupRoleInput[], lineup?: Lineup, workspaceId?: string): LineupRole[]
  /** The workspace's presets of run settings for the Change lineup, first first. */
  'preset.list'(workspaceId?: string): LineupPreset[]
  /**
   * Adds a preset (no id) or replaces the one with that id, renaming it if the name changed. The settings are checked against the
   * Change lineup. Rejects a blank, long or taken name, and settings that don't fit the lineup, with a message for the settings screen.
   */
  'preset.save'(preset: LineupPresetInput, workspaceId?: string): LineupPreset
  /** Removes the preset. Tickets that used it keep their settings. */
  'preset.remove'(id: string): void
  'allowRules.list'(workspaceId?: string): AllowRule[]
  'allowRules.remove'(id: string): void
  /** How agents run the mainbus CLI and MCP server of this app; null when not known (tests). */
  'agents.launcher'(): AgentLauncher | null
  /** The app's global settings. */
  'settings.get'(): AppSettings
  /**
   * "Agents running at once": a whole number from 1 to 10. Lowering it stops no running agent; new starts queue until
   * fewer are running than the new number. Only the renderer can reach it.
   */
  'settings.setMaxAgents'(n: number): AppSettings
  /** "When I close the window": 'tray' keeps Mainbus running while agents are open, 'quit' always quits. Only the renderer can reach it. */
  'settings.setWhenClosed'(v: WhenClosed): AppSettings
  /** "Let the orchestrator read web pages": whether it may use WebFetch and WebSearch. Takes effect at its next tool call. Only the renderer can reach it. */
  'settings.setOrchestratorWebAccess'(on: boolean): AppSettings
  /** "Theme": a theme id, or 'system' (Match Windows). Applied live, through a theme.changed event. Only the renderer can reach it. */
  'settings.setTheme'(v: ThemeChoice): AppSettings
  /** The light or the dark theme Match Windows uses. Applied live, through a theme.changed event. Only the renderer can reach it. */
  'settings.setMatchWindowsTheme'(scheme: ThemeScheme, id: ThemeId): AppSettings
  /**
   * Unattended mode: works through Ready one ticket at a time. Only the renderer can reach these: the agent
   * intake (pipe, CLI, MCP) has no way to switch it on. Each workspace has its own, remembered across a restart; the focused workspace unless given.
   */
  'unattended.get'(workspaceId?: string): UnattendedState
  'unattended.set'(on: boolean, workspaceId?: string): UnattendedState
  /** The usage limit state: ok, a warning near the limit, or limited. Only the renderer can reach these. */
  'usage.get'(): UsageState
  /** Resume now: ends the usage-limited state early and resumes the paused agents in the order they were paused. */
  'usage.resumeNow'(): void
  /**
   * The orchestrator: one conversation for the whole app, which only reads. Like unattended mode, only the
   * renderer can reach it. `get` gives every run's events and its status.
   */
  'orchestrator.get'(): OrchestratorThread
  /** What the orchestrator's turns used, over all its runs; null when none was recorded. */
  'orchestrator.usage'(): UsageTotals | null
  /**
   * Starts the conversation on the first message, or resumes it after a restart. `images` go with it (at most 5,
   * checked like attachments); a message with neither text nor images is rejected. `mentions` are the ids of
   * the workspaces the user picked from the @ list; `@name` typed by hand is resolved by the engine.
   */
  'orchestrator.send'(text: string, images?: NewAttachment[], mentions?: string[]): void
  /** An image sent to the orchestrator, as a data URL: the renderer's only way to its file. */
  'orchestrator.image'(id: string): string
  /** Interrupts the turn under way; the conversation goes on with the next message. */
  'orchestrator.stop'(): void
  /**
   * The user dragged a Backlog or Ready card into In progress: stores a start proposal for it (the whole lineup),
   * with no orchestrator turn. Returns the pending proposal; an existing pending start for the ticket is returned
   * as it is. Only the renderer can reach it.
   */
  'ticket.proposeStart'(ticketId: string): Proposal
  /**
   * The user pressed Replace… on a ticket with an open run: stores a replace proposal for its active role, with no
   * orchestrator turn and no stuck episode needed. Returns the pending proposal, which the orchestrator panel shows;
   * one already pending for the ticket is returned as it is. Only the renderer can reach it.
   */
  'ticket.proposeReplace'(ticketId: string): Proposal
  /**
   * The orchestrator's proposals, decided once only. Confirm carries it out: as proposed, or with the user's
   * `override` (validated like the proposal). A failure while carrying it out comes back as a failed proposal.
   */
  'proposal.confirm'(id: string, override?: unknown): Proposal
  'proposal.reject'(id: string): Proposal
}

export type CommandName = keyof EngineCommands

export type CommandArgs<K extends CommandName> = Parameters<EngineCommands[K]>
export type CommandResult<K extends CommandName> = ReturnType<EngineCommands[K]>

/** What the preload exposes as `window.mainbus`. */
export interface MainbusApi {
  invoke<K extends CommandName>(command: K, ...args: CommandArgs<K>): Promise<CommandResult<K>>
  /** Subscribes to engine events; returns the unsubscribe function. */
  on(listener: (e: EngineEvent) => void): () => void
  /** Shows the native folder picker. Resolves to the chosen folder, or null when the user cancels. */
  openFolder(): Promise<string | null>
  /** Subscribes to the main process asking the app to show a ticket or the Needs you column; returns the unsubscribe function. */
  onNavigate(listener: (nav: AppNavigation) => void): () => void
}

/** The IPC channels between the preload and the main process. */
export const INVOKE_CHANNEL = 'engine:invoke'
export const EVENT_CHANNEL = 'engine:event'
export const OPEN_FOLDER_CHANNEL = 'dialog:openFolder'

/** The channel on which the main process tells the renderer to show something (a toast or the tray was clicked). */
export const NAVIGATE_CHANNEL = 'app:navigate'

/** Where the main process asks the renderer to go. `needsYou` shows the board and its Needs you column. */
export type AppNavigation =
  | { to: 'ticket'; workspaceId: string; ticketId: string }
  | { to: 'needsYou'; workspaceId: string | null }

/** The `name` of the error thrown by agent commands when Claude is not set up. Electron keeps it in the rejection's message. */
export const SETUP_REQUIRED = 'SetupRequiredError'
