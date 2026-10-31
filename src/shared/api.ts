// Shared by the engine, the preload and the renderer: no Node imports (the renderer typechecks this file).
// Mostly types; the channel names and error name at the bottom are the only runtime values.
import type {
  AgentLauncher,
  AllowRule,
  ClaudeSetup,
  Decision,
  DecisionAnswer,
  NewTicketInput,
  Role,
  Ticket,
  TicketPatch,
  TicketState,
  Workspace
} from './domain'
import type { StoredEvent } from './events'

/** What the engine pushes to the renderer. Partial (streaming) thread events carry seq 0: they are never stored. */
export type EngineEvent =
  | { type: 'board.changed'; workspaceId: string }
  | { type: 'thread.appended'; ticketId: string; event: StoredEvent }
  | { type: 'decision.changed'; decision: Decision }

/** Every command the renderer can send to the engine. A thrown error reaches the renderer as a rejected promise. */
export interface EngineCommands {
  'setup.check'(): ClaudeSetup
  'workspace.get'(): Workspace | null
  /** Detects the base branch with `git symbolic-ref --short HEAD`. The MVP supports one workspace. */
  'workspace.open'(repoPath: string): Workspace
  'board.get'(): { tickets: (Ticket & { state: TicketState })[] }
  /** The user's own ticket: a source can only come in through agent intake. */
  'ticket.create'(i: Omit<NewTicketInput, 'workspaceId' | 'source'>): Ticket
  'ticket.update'(id: string, p: TicketPatch): Ticket
  'ticket.appendIntent'(id: string, text: string): Ticket
  /** Moving to done can answer 'dirty': the worktree has uncommitted work and the ticket stays where it was. */
  'ticket.move'(id: string, c: 'backlog' | 'ready' | 'done'): 'moved' | 'dirty'
  'thread.get'(ticketId: string): { events: StoredEvent[]; decisions: Decision[] }
  'agent.start'(ticketId: string): void
  'agent.send'(ticketId: string, text: string): void
  'agent.stop'(ticketId: string): void
  'agent.continue'(ticketId: string): void
  'decision.answer'(id: string, a: DecisionAnswer): void
  'role.get'(): Role
  'role.update'(p: Partial<Pick<Role, 'instructions' | 'model' | 'effort'>>): Role
  'allowRules.list'(): AllowRule[]
  'allowRules.remove'(id: string): void
  /** How agents run the mainbus CLI and MCP server of this app; null when not known (tests). */
  'agents.launcher'(): AgentLauncher | null
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
