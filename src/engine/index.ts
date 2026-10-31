import fs from 'node:fs/promises'
import path from 'node:path'
import {
  SETUP_REQUIRED,
  type CommandArgs,
  type CommandName,
  type CommandResult,
  type EngineEvent
} from '../shared/api'
import type { AgentLauncher, NewTicketInput, Ticket, Workspace } from '../shared/domain'
import { openDb } from './db/open'
import type { GitRunner } from './git/git'
import { slugify } from './git/slug'
import { WorktreeManager } from './git/worktrees'
import type { HomePaths } from './home'
import { createIntakeHandler, type IntakeHandler } from './intake/methods'
import { TicketRunner } from './runner/ticketRunner'
import { UnattendedMode, type KeepAwake } from './runner/unattended'
import { resolveClaude, type ExecFn } from './runtime/resolveClaude'
import type { AgentRuntime } from './runtime/types'
import { createRepos } from './store'

/** Thrown by agent commands when Claude Code isn't set up (no usable `claude` binary, or not logged in). */
export class SetupRequiredError extends Error {
  constructor(message = 'Claude Code is not set up: install it and log in, then restart Mainbus') {
    super(message)
    this.name = SETUP_REQUIRED
  }
}

export interface EngineConfig {
  paths: HomePaths
  migrationsDir: string
  /** Null when setup is incomplete: agent commands then throw SetupRequiredError. */
  runtime: AgentRuntime | null
  git: GitRunner
  exec: ExecFn
  /** Shown in the Connect agents settings. */
  launcher?: AgentLauncher | null
  /** Why the intake pipe couldn't be opened, if it couldn't; shown in the Connect agents settings. */
  intakeError?: () => string | null
  /** Held exactly while unattended mode is on; the app passes Electron's powerSaveBlocker. */
  keepAwake?: KeepAwake
}

export interface Engine {
  invoke<K extends CommandName>(k: K, ...args: CommandArgs<K>): Promise<CommandResult<K>>
  /** Subscribes to engine events; returns the unsubscribe function. */
  on(listener: (e: EngineEvent) => void): () => void
  /** Answers requests from local agents (the intake pipe). Creates tickets in Backlog, lists and reads them; nothing else. */
  intake: IntakeHandler
  /** Stops live agents (their runs stay resumable) and closes the database. Safe to call twice. */
  dispose(): Promise<void>
}

type Handlers = {
  [K in CommandName]: (...args: CommandArgs<K>) => CommandResult<K> | Promise<CommandResult<K>>
}

/** Stands in for a runtime when setup is incomplete. The facade stops agent commands before they reach it. */
const missingRuntime: AgentRuntime = {
  start: () => Promise.reject(new SetupRequiredError()),
  send: () => Promise.reject(new SetupRequiredError()),
  interrupt: () => Promise.reject(new SetupRequiredError()),
  stop: () => Promise.resolve(),
  // Never called: there is no run without a runtime.
  events: () => (async function* () {})()
}

const WORKSPACE_REQUIRED = 'Open a workspace first'

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export async function createEngine(cfg: EngineConfig): Promise<Engine> {
  const now = () => new Date()
  const handle = await openDb(cfg.paths, cfg.migrationsDir)
  try {
    const repos = createRepos(handle.db, now)
    const listeners = new Set<(e: EngineEvent) => void>()
    // Created below, once the runner it drives exists; it sees every event before the listeners do.
    let unattended: UnattendedMode | null = null
    const emit = (e: EngineEvent): void => {
      unattended?.observe(e)
      for (const listener of [...listeners]) {
        try {
          listener(e)
        } catch {
          // One bad listener must not stop the others or the engine.
        }
      }
    }

    const worktrees = new WorktreeManager(cfg.git, cfg.paths, repos.cleanups)
    const runner = new TicketRunner({
      repos,
      worktrees,
      runtime: cfg.runtime ?? missingRuntime,
      now,
      emit,
      unattended: () => unattended?.isOn() ?? false
    })
    await worktrees.recoverPendingCleanups()
    await runner.markAllNotAlive()

    const requireWorkspace = async (): Promise<Workspace> => {
      const ws = await repos.workspaces.get()
      if (!ws) throw new Error(WORKSPACE_REQUIRED)
      return ws
    }
    const requireRuntime = (): void => {
      if (cfg.runtime === null) throw new SetupRequiredError()
    }

    // Always off at launch: nothing about it is stored.
    const mode = new UnattendedMode({
      runner,
      tickets: async () => {
        const ws = await repos.workspaces.get()
        return ws ? repos.tickets.list(ws.id) : []
      },
      checkCanRun: async () => {
        requireRuntime()
        await requireWorkspace()
      },
      emit,
      keepAwake: cfg.keepAwake ?? { start: () => {}, stop: () => {} },
      now
    })
    unattended = mode

    async function openWorkspace(repoPath: string): Promise<Workspace> {
      const folder = path.resolve(repoPath)
      const isFolder = await fs.stat(folder).then(
        (s) => s.isDirectory(),
        () => false
      )
      if (!isFolder) throw new Error(`Folder does not exist: ${folder}`)

      // A subfolder opens its repository: the workspace is the repo root.
      const top = await cfg.git(['rev-parse', '--show-toplevel'], folder)
      if (top.code !== 0 || top.stdout.trim() === '') {
        const why = top.stderr.trim()
        throw new Error(
          /not a git repository/i.test(why)
            ? `${folder} is not a git repository`
            : `Could not read the repository at ${folder}: ${why || 'git failed'}`
        )
      }
      const root = path.resolve(top.stdout.trim())

      const existing = await repos.workspaces.get()
      if (existing) {
        if (samePath(path.resolve(existing.repoPath), root)) return existing
        throw new Error(`Mainbus MVP supports one workspace; ${existing.repoPath} is already open`)
      }

      if ((await cfg.git(['rev-parse', '--verify', 'HEAD'], root)).code !== 0) {
        throw new Error('The repository has no commits yet.')
      }
      const head = await cfg.git(['symbolic-ref', '--short', 'HEAD'], root)
      const baseBranch = head.stdout.trim()
      if (head.code !== 0 || baseBranch === '') {
        throw new Error(
          `Could not read the current branch of ${root}: ${head.stderr.trim() || 'HEAD is not on a branch'}`
        )
      }
      const name = path.basename(root)
      const workspace = await repos.workspaces.create(root, baseBranch, name, slugify(name))
      emit({ type: 'board.changed', workspaceId: workspace.id })
      return workspace
    }

    /** The one way a ticket is created, by the user (ticket.create) or by an agent (intake). */
    async function createTicket(ws: Workspace, input: Omit<NewTicketInput, 'workspaceId'>): Promise<Ticket> {
      const ticket = await repos.tickets.create({ ...input, workspaceId: ws.id })
      emit({ type: 'board.changed', workspaceId: ws.id })
      return ticket
    }

    const boardTickets = async (ws: Workspace) => {
      const tickets = await repos.tickets.list(ws.id)
      return Promise.all(tickets.map(async (t) => ({ ...t, state: await runner.stateOf(t.id) })))
    }
    const boardTicket = async (ws: Workspace, number: number) => {
      const ticket = await repos.tickets.byNumber(ws.id, number)
      return ticket && { ...ticket, state: await runner.stateOf(ticket.id) }
    }

    const handlers: Handlers = {
      'setup.check': async () => {
        const setup = await resolveClaude(cfg.exec)
        // Claude was fixed after launch: the runtime is chosen once, at startup.
        if (setup.ok && cfg.runtime === null) {
          return { ok: false, reason: 'restart_required', detail: 'Restart Mainbus to use Claude Code.' }
        }
        return setup
      },
      'workspace.get': () => repos.workspaces.get(),
      'workspace.open': openWorkspace,

      'board.get': async () => {
        const ws = await repos.workspaces.get()
        return { tickets: ws ? await boardTickets(ws) : [] }
      },

      // The user's own words: never marked as agent-written, whatever the renderer sends.
      'ticket.create': async (input) => createTicket(await requireWorkspace(), { ...input, source: undefined }),
      'ticket.update': async (id, patch) => {
        const ticket = await repos.tickets.update(id, patch)
        emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
        return ticket
      },
      'ticket.appendIntent': async (id, text) => {
        const ticket = await repos.tickets.appendIntent(id, text)
        emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
        return ticket
      },
      'ticket.move': async (id, column) => {
        if (column === 'done') return (await runner.moveToDone(id)) === 'done' ? 'moved' : 'dirty'
        await runner.moveToColumn(id, column)
        return 'moved'
      },

      // Every run of the ticket, oldest first, so Start again keeps the earlier runs in view.
      'thread.get': async (ticketId) => {
        const runs = await repos.runs.listForTicket(ticketId)
        const events = (await Promise.all(runs.map((run) => repos.runs.events(run.id)))).flat()
        return { events, decisions: await repos.decisions.forTicket(ticketId) }
      },

      'agent.start': (ticketId) => {
        requireRuntime()
        return runner.start(ticketId)
      },
      'agent.send': (ticketId, text) => {
        requireRuntime()
        return runner.send(ticketId, text)
      },
      // Stopping needs no runtime: without one nothing is live, and a paused run can still be ended.
      // Stopping the ticket unattended mode is running turns the mode off: the user is here.
      'agent.stop': (ticketId) => {
        mode.userStopped(ticketId)
        return runner.stop(ticketId)
      },
      'agent.continue': (ticketId) => {
        requireRuntime()
        return runner.continue(ticketId)
      },
      'decision.answer': (id, answer) => {
        requireRuntime()
        return runner.answer(id, answer)
      },

      'role.get': async () => repos.roles.get((await requireWorkspace()).id),
      'role.update': async (patch) => repos.roles.update((await requireWorkspace()).id, patch),

      'allowRules.list': async () => {
        const ws = await repos.workspaces.get()
        return ws ? repos.allowRules.list(ws.id) : []
      },
      'allowRules.remove': (id) => repos.allowRules.remove(id),

      'agents.launcher': () => {
        if (!cfg.launcher) return null
        const intakeError = cfg.intakeError?.() ?? null
        return intakeError === null ? cfg.launcher : { ...cfg.launcher, intakeError }
      },

      // Reached only through `invoke` (the renderer's IPC); the intake handler below has no way to it.
      'unattended.get': () => mode.get(),
      'unattended.set': (on) => mode.set(on === true)
    }

    const intake = createIntakeHandler({
      workspace: () => repos.workspaces.get(),
      createTicket,
      tickets: boardTickets,
      ticket: boardTicket
    })

    let disposal: Promise<void> | null = null
    return {
      async invoke(k, ...args) {
        if (disposal) throw new Error('Mainbus is shutting down')
        if (!Object.hasOwn(handlers, k)) throw new Error(`Unknown command: ${String(k)}`)
        const handler = handlers[k] as (...a: unknown[]) => unknown
        return (await handler(...args)) as CommandResult<typeof k>
      },
      intake(method, params) {
        if (disposal) return Promise.reject(new Error('Mainbus is shutting down'))
        return intake(method, params)
      },
      on(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      dispose() {
        disposal ??= (async () => {
          try {
            // First, so the queue starts nothing while the agents are stopped.
            mode.dispose()
            await runner.shutdown()
          } finally {
            listeners.clear()
            handle.close()
          }
        })()
        return disposal
      }
    }
  } catch (error) {
    handle.close()
    throw error
  }
}
