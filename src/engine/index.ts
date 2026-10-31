import fs from 'node:fs/promises'
import path from 'node:path'
import {
  SETUP_REQUIRED,
  type CommandArgs,
  type CommandName,
  type CommandResult,
  type EngineEvent
} from '../shared/api'
import type { Workspace } from '../shared/domain'
import { openDb } from './db/open'
import type { GitRunner } from './git/git'
import { slugify } from './git/slug'
import { WorktreeManager } from './git/worktrees'
import type { HomePaths } from './home'
import { TicketRunner } from './runner/ticketRunner'
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
}

export interface Engine {
  invoke<K extends CommandName>(k: K, ...args: CommandArgs<K>): Promise<CommandResult<K>>
  /** Subscribes to engine events; returns the unsubscribe function. */
  on(listener: (e: EngineEvent) => void): () => void
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
    const emit = (e: EngineEvent): void => {
      for (const listener of [...listeners]) {
        try {
          listener(e)
        } catch {
          // One bad listener must not stop the others or the engine.
        }
      }
    }

    const worktrees = new WorktreeManager(cfg.git, cfg.paths, repos.cleanups)
    const runner = new TicketRunner({ repos, worktrees, runtime: cfg.runtime ?? missingRuntime, now, emit })
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
        if (!ws) return { tickets: [] }
        const tickets = await repos.tickets.list(ws.id)
        return { tickets: await Promise.all(tickets.map(async (t) => ({ ...t, state: await runner.stateOf(t.id) }))) }
      },

      'ticket.create': async (input) => {
        const ws = await requireWorkspace()
        const ticket = await repos.tickets.create({ ...input, workspaceId: ws.id })
        emit({ type: 'board.changed', workspaceId: ws.id })
        return ticket
      },
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
      'agent.stop': (ticketId) => runner.stop(ticketId),
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
      'allowRules.remove': (id) => repos.allowRules.remove(id)
    }

    let disposal: Promise<void> | null = null
    return {
      async invoke(k, ...args) {
        if (disposal) throw new Error('Mainbus is shutting down')
        if (!Object.hasOwn(handlers, k)) throw new Error(`Unknown command: ${String(k)}`)
        const handler = handlers[k] as (...a: unknown[]) => unknown
        return (await handler(...args)) as CommandResult<typeof k>
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
