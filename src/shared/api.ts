// Shared by the engine, the preload and the renderer: no Node imports (the renderer typechecks this file).
// Mostly types; the channel names and error name at the bottom are the only runtime values.
import type {
  AgentLauncher,
  AllowRule,
  ClaudeSetup,
  Decision,
  DecisionAnswer,
  GhStatus,
  LineupRole,
  LineupRoleInput,
  NewTicketInput,
  StartOptions,
  Ticket,
  TicketPatch,
  TicketState,
  UnattendedState,
  Workspace
} from './domain'
import type { StoredEvent } from './events'

/** What the engine pushes to the renderer. Partial (streaming) thread events carry seq 0: they are never stored. */
export type EngineEvent =
  | { type: 'board.changed'; workspaceId: string }
  | { type: 'thread.appended'; ticketId: string; event: StoredEvent }
  | { type: 'decision.changed'; decision: Decision }
  | { type: 'unattended.changed'; state: UnattendedState }

/** Every command the renderer can send to the engine. A thrown error reaches the renderer as a rejected promise. */
export interface EngineCommands {
  'setup.check'(): ClaudeSetup
  'workspace.get'(): Workspace | null
  /** Detects the base branch with `git symbolic-ref --short HEAD`. The MVP supports one workspace. */
  'workspace.open'(repoPath: string): Workspace
  /**
   * The switch "Open a PR when a ticket reaches Review". Like Retry below, only the renderer can reach it:
   * the agent intake (pipe, CLI, MCP) has no way to make Mainbus push.
   */
  'workspace.setOpenPrOnReview'(on: boolean): Workspace
  /** Whether the GitHub CLI is installed and signed in; never any of its output. */
  'github.check'(): GhStatus
  'board.get'(): { tickets: (Ticket & { state: TicketState })[] }
  /** The user's own ticket: a source can only come in through agent intake. */
  'ticket.create'(i: Omit<NewTicketInput, 'workspaceId' | 'source'>): Ticket
  'ticket.update'(id: string, p: TicketPatch): Ticket
  'ticket.appendIntent'(id: string, text: string): Ticket
  /** Moving to done can answer 'dirty': the worktree has uncommitted work and the ticket stays where it was. */
  'ticket.move'(id: string, c: 'backlog' | 'ready' | 'done'): 'moved' | 'dirty'
  /** Retry: pushes the branch of a ticket in Review again and opens its PR if it has none. Never forces. */
  'ticket.openPr'(id: string): void
  'thread.get'(ticketId: string): { events: StoredEvent[]; decisions: Decision[] }
  /**
   * Runs the ticket through its lineup, as a new ticket run. `roleIds` picks the roles to run (in lineup order);
   * without it every role runs. Rejects an empty list or an id that isn't in the lineup.
   */
  'agent.start'(ticketId: string, opts?: StartOptions): void
  'agent.send'(ticketId: string, text: string): void
  'agent.stop'(ticketId: string): void
  'agent.continue'(ticketId: string): void
  'decision.answer'(id: string, a: DecisionAnswer): void
  /** The workspace's Change lineup, first role first. */
  'lineup.get'(): LineupRole[]
  /**
   * Replaces the whole Change lineup, in order. Rejects, with a message for the settings screen, a lineup with no
   * roles, an empty or duplicate name, or a hand-back to a role that isn't earlier in the lineup.
   */
  'lineup.save'(roles: LineupRoleInput[]): LineupRole[]
  'allowRules.list'(): AllowRule[]
  'allowRules.remove'(id: string): void
  /** How agents run the mainbus CLI and MCP server of this app; null when not known (tests). */
  'agents.launcher'(): AgentLauncher | null
  /**
   * Unattended mode: works through Ready one ticket at a time. Only the renderer can reach these: the agent
   * intake (pipe, CLI, MCP) has no way to switch it on. It is off whenever the app starts.
   */
  'unattended.get'(): UnattendedState
  'unattended.set'(on: boolean): UnattendedState
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
}

/** The IPC channels between the preload and the main process. */
export const INVOKE_CHANNEL = 'engine:invoke'
export const EVENT_CHANNEL = 'engine:event'
export const OPEN_FOLDER_CHANNEL = 'dialog:openFolder'

/** The `name` of the error thrown by agent commands when Claude is not set up. Electron keeps it in the rejection's message. */
export const SETUP_REQUIRED = 'SetupRequiredError'
