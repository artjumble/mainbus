import fs from 'node:fs/promises'
import path from 'node:path'
import {
  SETUP_REQUIRED,
  type BoardTicket,
  type CommandArgs,
  type CommandName,
  type CommandResult,
  type EngineEvent
} from '../shared/api'
import type { DraftColumn } from '../shared/proposals'
import type { AgentLauncher, LineupRole, NewTicketInput, Ticket, Workspace } from '../shared/domain'
import { openDb } from './db/open'
import { realClock, type Clock } from './holds/clock'
import { HoldService } from './holds/holds'
import { runCommand, type CommandRunner } from './git/command'
import type { GitRunner } from './git/git'
import { PullRequestPublisher } from './git/pullRequests'
import { slugify } from './git/slug'
import { WorktreeManager } from './git/worktrees'
import type { HomePaths } from './home'
import { createIntakeHandler, type IntakeHandler } from './intake/methods'
import { COLUMNS, createReadTools } from './orchestrator/readTools'
import type { ReleasedHold } from './orchestrator/releasedHoldsBlock'
import type { ResurfacedDecision } from './orchestrator/resurfacedBlock'
import { OrchestratorSession } from './orchestrator/session'
import { createProposalService } from './proposals/service'
import { TicketRunner, type RunExpectation } from './runner/ticketRunner'
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
  /** Runs `git push` and `gh` for pull requests; tests pass a fake gh. Defaults to running them for real. */
  commands?: CommandRunner
  /** Shown in the Connect agents settings. */
  launcher?: AgentLauncher | null
  /** Why the intake pipe couldn't be opened, if it couldn't; shown in the Connect agents settings. */
  intakeError?: () => string | null
  /** Held while unattended mode is on and a ticket is working or a usage limit is waited out; the app passes Electron's powerSaveBlocker. */
  keepAwake?: KeepAwake
  /** The time and the one timer that releases holds on their date; tests (and the end-to-end tests) pass a fake. */
  clock?: Clock
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
  summarize: () => Promise.reject(new SetupRequiredError()),
  // Never called: there is no run without a runtime.
  events: () => (async function* () {})()
}

const WORKSPACE_REQUIRED = 'Open a workspace first'

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export async function createEngine(cfg: EngineConfig): Promise<Engine> {
  const clock = cfg.clock ?? realClock
  const now = () => clock.now()
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

    const holds = new HoldService({ holds: repos.holds, tickets: repos.tickets, decisions: repos.decisions, clock, emit })

    const worktrees = new WorktreeManager(cfg.git, cfg.paths, repos.cleanups)
    const pullRequests = new PullRequestPublisher(cfg.commands ?? runCommand)
    const runner = new TicketRunner({
      repos,
      worktrees,
      runtime: cfg.runtime ?? missingRuntime,
      now,
      emit,
      unattended: () => unattended?.isOn() ?? false,
      pullRequests
    })
    await worktrees.recoverPendingCleanups()
    await runner.markAllNotAlive()
    // Holds that came due while Mainbus was closed are released before anything can start a ticket.
    await holds.start()

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
      held: () => holds.heldIds(),
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

    /**
     * The one way tickets are created: by the user (ticket.create), by an agent (intake), or from a proposal the
     * user confirmed. In order, all of them or none.
     */
    async function createTickets(
      ws: Workspace,
      inputs: Omit<NewTicketInput, 'workspaceId'>[],
      record?: { proposalId: string; column: DraftColumn }
    ): Promise<Ticket[]> {
      const tickets = await repos.tickets.createMany(
        inputs.map((input) => ({ ...input, workspaceId: ws.id })),
        record && ((ids) => [repos.proposals.ticketsResultStatement(record.proposalId, ids, record.column)])
      )
      emit({ type: 'board.changed', workspaceId: ws.id })
      return tickets
    }
    const createTicket = async (ws: Workspace, input: Omit<NewTicketInput, 'workspaceId'>): Promise<Ticket> =>
      (await createTickets(ws, [input]))[0]!

    // The ticket view's Pause, Stop and Skip; a confirmed proposal goes through the same functions.
    // With `expect`, they fail rather than act on a role other than the one named.
    // Stopping needs no runtime: without one nothing is live, and a paused run can still be ended.
    // Stopping the ticket unattended mode is running turns the mode off: the user is here.
    const stopTicket = (ticketId: string, expect?: RunExpectation): Promise<void> => {
      mode.userStopped(ticketId)
      return runner.stop(ticketId, expect)
    }
    // Like Stop: pausing needs no runtime, and pausing the ticket unattended mode is running turns the mode off.
    const pauseTicket = (ticketId: string, expect?: RunExpectation): Promise<void> => {
      mode.userPaused(ticketId)
      return runner.pause(ticketId, expect)
    }
    const skipTicket = (ticketId: string, expect?: RunExpectation): Promise<void> => {
      requireRuntime()
      return runner.skip(ticketId, expect)
    }

    // Confirmed proposals are carried out here, by engine code, never by the orchestrator.
    const proposals = createProposalService({
      repo: repos.proposals,
      emit,
      exec: {
        workspace: () => repos.workspaces.get(),
        createTickets,
        lineup: (workspaceId) => repos.lineups.get(workspaceId),
        ticketByNumber: (workspaceId, number) => repos.tickets.byNumber(workspaceId, number),
        async whyNotStartable(ticket) {
          const held = await holds.active(ticket.id)
          if (held) {
            const until = held.until === null ? '' : ` until ${held.until.slice(0, 10)}`
            return `#${ticket.number} is on hold${until}; the user has to release the hold first`
          }
          // Checked before the column: a running ticket is In progress or Needs you, and is said to be running.
          const latest = await repos.runs.latest(ticket.id)
          if ((latest && latest.endReason === null) || runner.isLaunching(ticket.id)) {
            return `#${ticket.number} is already running`
          }
          const { column } = await runner.stateOf(ticket.id)
          if (column === 'backlog' || column === 'ready') return null
          return `#${ticket.number} is in ${COLUMNS[column]}; only Backlog or Ready tickets can be started`
        },
        startTicket: (ticketId, opts) => {
          requireRuntime()
          return runner.start(ticketId, opts)
        },
        async activeRole(ticket) {
          return runner.activeRole(ticket.id)
        },
        pauseTicket,
        stopTicket,
        skipTicket,
        now,
        holdTicket: (ticketId, opts) => holds.hold(ticketId, opts)
      }
    })

    // Before the orchestrator panel or the outcome block can read proposals.
    await proposals.failUnfinished()

    // The intake's tickets need only their state; the board's carry their lineup strip as well.
    const boardTickets = async (ws: Workspace) => {
      const tickets = await repos.tickets.list(ws.id)
      return Promise.all(tickets.map(async (t) => ({ ...t, state: await runner.stateOf(t.id) })))
    }
    const boardTicket = async (ws: Workspace, number: number) => {
      const ticket = await repos.tickets.byNumber(ws.id, number)
      return ticket && { ...ticket, state: await runner.stateOf(ticket.id) }
    }

    const boardView = async (ws: Workspace): Promise<BoardTicket[]> => {
      const tickets = await repos.tickets.list(ws.id)
      const holdOf = new Map((await repos.holds.activeOf('ticket')).map((h) => [h.targetId, h]))
      // Read once, for every ticket that hasn't run yet.
      let lineup: Promise<LineupRole[]> | undefined
      const workspaceLineup = () => (lineup ??= repos.lineups.get(ws.id))
      return Promise.all(tickets.map(async (t) => ({ ...t, ...(await runner.boardView(t.id, workspaceLineup)), hold: holdOf.get(t.id) ?? null })))
    }

    // Its events never reach unattended mode as board changes: the orchestrator is not a ticket.
    const orchestrator = new OrchestratorSession({
      repo: repos.orchestrator,
      runtime: cfg.runtime ?? missingRuntime,
      homeRoot: cfg.paths.root,
      now,
      emit,
      workspace: () => repos.workspaces.get(),
      workspaceRequired: WORKSPACE_REQUIRED,
      readTools: createReadTools({ repos, workspace: () => repos.workspaces.get(), board: boardView }),
      proposals,
      answeredSince: (workspaceId, since) => repos.decisions.answeredSince(workspaceId, since),
      releasedSince: async (workspaceId, since) => {
        const released: ReleasedHold[] = []
        for (const h of await repos.holds.releasedSince('ticket', since)) {
          const ticket = await repos.tickets.get(h.targetId).catch(() => null)
          if (ticket?.workspaceId === workspaceId && h.releasedAt !== null) {
            released.push({ number: ticket.number, title: ticket.title, until: h.until, releasedAt: h.releasedAt })
          }
        }
        return released
      },
      resurfacedSince: async (workspaceId, since) => {
        const resurfaced: ResurfacedDecision[] = []
        for (const h of await repos.holds.releasedSince('decision', since)) {
          // Only those whose date came: an answer or Bring back released the others.
          if (h.until === null || h.releasedAt === null || h.until > h.releasedAt) continue
          const decision = await repos.decisions.get(h.targetId).catch(() => null)
          if (decision?.status !== 'pending') continue
          const ticket = await repos.tickets.get(decision.ticketId).catch(() => null)
          if (ticket?.workspaceId === workspaceId) {
            resurfaced.push({ number: ticket.number, title: ticket.title, question: decision.question, until: h.until })
          }
        }
        return resurfaced
      }
    })

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
      // Reached only through `invoke` (the renderer's IPC), like ticket.openPr and unattended.set.
      'workspace.setOpenPrOnReview': async (on) => {
        const ws = await repos.workspaces.setOpenPrOnReview((await requireWorkspace()).id, on === true)
        emit({ type: 'board.changed', workspaceId: ws.id })
        return ws
      },
      'github.check': async () => pullRequests.checkGh((await requireWorkspace()).repoPath),

      'board.get': async () => {
        const ws = await repos.workspaces.get()
        return { tickets: ws ? await boardView(ws) : [] }
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
        mode.userMoved(id, column)
        if (column === 'done') {
          const moved = (await runner.moveToDone(id)) === 'done'
          // A Done ticket has nothing left to hold back.
          if (moved) await holds.unhold(id)
          return moved ? 'moved' : 'dirty'
        }
        await runner.moveToColumn(id, column)
        return 'moved'
      },
      'ticket.hold': (id, opts) => holds.hold(id, opts),
      'ticket.unhold': (id) => holds.unhold(id),
      'ticket.openPr': (id) => runner.openPr(id),

      // Every run of the ticket, oldest first, so Start again keeps the earlier runs in view.
      'thread.get': async (ticketId) => {
        const runs = await repos.runs.listForTicket(ticketId)
        const events = (await Promise.all(runs.map((run) => repos.runs.events(run.id)))).flat()
        return {
          events,
          decisions: await repos.decisions.forTicket(ticketId),
          runs: runs.map((run) => ({ id: run.id, ticketRunId: run.ticketRunId, role: run.role }))
        }
      },

      // The user starting a held ticket by hand releases its hold (once the start has gone through).
      'agent.start': async (ticketId, opts) => {
        requireRuntime()
        await runner.start(ticketId, opts)
        await holds.unhold(ticketId)
      },
      'agent.send': (ticketId, text) => {
        requireRuntime()
        return runner.send(ticketId, text)
      },
      'agent.stop': (ticketId) => stopTicket(ticketId),
      'agent.continue': (ticketId) => {
        requireRuntime()
        return runner.continue(ticketId)
      },
      'agent.pause': (ticketId) => pauseTicket(ticketId),
      'agent.resume': (ticketId) => {
        requireRuntime()
        return runner.resumePaused(ticketId)
      },
      'agent.skip': (ticketId) => skipTicket(ticketId),
      'decision.answer': (id, answer, via) => {
        requireRuntime()
        return runner.answer(id, answer, via)
      },

      'decision.defer': (id, until) => holds.defer(id, until),
      'decision.bringBack': (id) => holds.bringBack(id),

      'lineup.get': async () => repos.lineups.get((await requireWorkspace()).id),
      // The board changes too: before a ticket's first run, its lineup strip is the workspace lineup.
      'lineup.save': async (roles) => {
        const ws = await requireWorkspace()
        const saved = await repos.lineups.save(ws.id, roles)
        emit({ type: 'board.changed', workspaceId: ws.id })
        return saved
      },

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
      'unattended.set': (on) => mode.set(on === true),

      // Reached only through `invoke` (the renderer's IPC). Like Stop, stopping and reading need no runtime.
      'orchestrator.get': () => orchestrator.get(),
      'orchestrator.send': (text) => {
        requireRuntime()
        return orchestrator.send(text)
      },
      'orchestrator.stop': () => orchestrator.stop(),
      'ticket.proposeStart': async (ticketId) => {
        const ws = await requireWorkspace()
        const ticket = await repos.tickets.get(ticketId)
        if (ticket.workspaceId !== ws.id) throw new Error('That ticket is not in the open workspace')
        return orchestrator.proposeStartFromDrag(ticket)
      },
      // Reached only through `invoke` (the renderer's IPC): only the user decides a proposal. No runtime needed.
      'proposal.confirm': (id, override) => proposals.confirm(id, override),
      'proposal.reject': (id) => proposals.reject(id)
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
            holds.dispose()
            await Promise.all([runner.shutdown(), orchestrator.shutdown()])
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
