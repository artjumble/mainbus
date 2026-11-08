import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  SETUP_REQUIRED,
  type BoardTicket,
  type CommandArgs,
  type CommandName,
  type CommandResult,
  type EngineEvent
} from '../shared/api'
import type { DraftColumn } from '../shared/proposals'
import {
  LINEUPS,
  type AgentLauncher,
  type Lineup,
  type LineupRole,
  type NewTicketInput,
  type RunSettingsInput,
  type StartOptions,
  type StuckEpisode,
  type Ticket,
  type TicketEdit,
  type Workspace
} from '../shared/domain'
import { applyRunSettings, checkRunSettings } from '../shared/runSettings'
import { openDb } from './db/open'
import { realClock, type Clock } from './holds/clock'
import { HoldService } from './holds/holds'
import { runCommand, type CommandRunner } from './git/command'
import type { GitRunner } from './git/git'
import { PullRequestPublisher } from './git/pullRequests'
import { ReportFileSaver } from './git/reportFiles'
import { slugify } from './git/slug'
import { BranchFreshnessChecker } from './git/freshness'
import { WorktreeManager } from './git/worktrees'
import { FreshnessMonitor, type FreshnessMonitorDeps } from './freshness/monitor'
import { LOCKFILES, updateInstructions, updateRoleOf } from './freshness/update'
import { orchestratorFolder, scratchPathFor, ticketFoldersFor, type HomePaths } from './home'
import { Attachments, type AttachmentWithPath } from './attachments/attachments'
import { createIntakeHandler, type IntakeHandler } from './intake/methods'
import { COLUMNS, createReadTools } from './orchestrator/readTools'
import type { AnsweredDecision } from './orchestrator/answeredBlock'
import type { ReleasedHold } from './orchestrator/releasedHoldsBlock'
import type { ResurfacedDecision } from './orchestrator/resurfacedBlock'
import type { StuckReport } from './orchestrator/stuckBlock'
import { OrchestratorImages } from './orchestrator/images'
import { OrchestratorSession } from './orchestrator/session'
import { ProposalInvalid, type TicketToCreate } from './proposals/kind'
import type { BatchItem } from 'drizzle-orm/batch'
import { insertDependencyStatements, replaceDependencyStatements } from './store/dependencies'
import { checkBlockers } from './tickets/dependencies'
import { notDoneYetText, openBlockers } from '../shared/dependencies'
import type { UnblockedTicket } from './orchestrator/unblockedBlock'
import { WakeScheduler } from './orchestrator/wakes'
import type { OpenDecision, WakeItem } from './orchestrator/wakeDigest'
import type { Wake, WakeKind } from './store/wakes'
import { createProposalService, type ProposalService } from './proposals/service'
import { ProcessSweeper } from './processes/sweep'
import { createSetupCommandRunner, type SetupCommandRunner } from './setup/setupCommand'
import { railCounts } from './state/railCounts'
import { StuckDetector, realTimer, type StuckDetectorDeps } from './stuck/detector'
import { newestChange } from './stuck/files'
import { firedAgainAfterRedirect } from './stuck/ladder'
import { TicketRunner, SKIP_SUMMARY_MS, type RunExpectation } from './runner/ticketRunner'
import { draftPromotionSpec, whyNotPromotable, withReportFile } from './tickets/promote'
import { planEdit, whyNotEditable, type EditInput } from './tickets/edit'
import { EditChangedError } from './store/ticketEdits'
import { ticketFields } from './tickets/validate'
import { UnattendedMode, type KeepAwake } from './runner/unattended'
import { UsageGate, usageHooks } from './runner/usageGate'
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
  /** Finds and ends the processes an agent leaves running; tests pass one with a fake process table. */
  processes?: ProcessSweeper
  /** Runs the workspace's setup command in a new ticket folder; tests pass a fake. By default the real thing, ending its processes with the sweeper above. */
  setupCommands?: SetupCommandRunner
  /** Shown in the Connect agents settings. */
  launcher?: AgentLauncher | null
  /** Why the intake pipe couldn't be opened, if it couldn't; shown in the Connect agents settings. */
  intakeError?: () => string | null
  /** Held while unattended mode is on and a ticket is working or a usage limit is waited out; the app passes Electron's powerSaveBlocker. */
  keepAwake?: KeepAwake
  /** The time and the one timer that releases holds on their date; tests (and the end-to-end tests) pass a fake. */
  clock?: Clock
  /** The stuck detector's timer, interval and file probe; tests pass fakes. By default a real timer, once a minute. */
  stuck?: Partial<Pick<StuckDetectorDeps, 'timer' | 'intervalMs' | 'newestChange'>>
  /** The freshness monitor's timer and interval; tests pass fakes. By default a real timer, every five minutes. */
  freshness?: Partial<Pick<FreshnessMonitorDeps, 'timer' | 'intervalMs'>>
  /** How long to wait before trying again when a usage limit has no known reset; 15 minutes by default (tests shorten it). */
  usageRetryMs?: number
  /** How long drafting a promoted ticket's spec may take before the report stands in; as long as a skip's summary by default (tests shorten it). */
  promoteSummaryTimeoutMs?: number
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

/** The lineup a request names, or an error: the renderer sends whatever it likes. */
function knownLineup(lineup: string): Lineup {
  if (!(LINEUPS as readonly string[]).includes(lineup)) throw new Error(`Unknown lineup: ${lineup}`)
  return lineup as Lineup
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** How long quitting waits for restart recovery to notice the shutdown. */
const RECOVERY_WAIT_MS = 5_000

export async function createEngine(cfg: EngineConfig): Promise<Engine> {
  const clock = cfg.clock ?? realClock
  const now = () => clock.now()
  const handle = await openDb(cfg.paths, cfg.migrationsDir)
  try {
    const repos = createRepos(handle.db, now)
    const listeners = new Set<(e: EngineEvent) => void>()
    // One unattended mode per workspace, created below once the runner they drive exists; each sees every event
    // before the listeners do.
    const modes = new Map<string, UnattendedMode>()
    let usageGate: UsageGate | null = null
    let wakeSchedulerRef: WakeScheduler | null = null
    let proposalService: ProposalService | null = null
    // The runner's, once it exists: a decision put off frees its agent's slot for the queue.
    let kickQueue: (() => void) | null = null
    const emit = (e: EngineEvent): void => {
      for (const m of modes.values()) m.observe(e)
      // Wake turns that waited for the reset get their turn once the limit lifts.
      if (e.type === 'usage.changed' && e.state.kind !== 'limited') void wakeSchedulerRef?.limitLifted()
      if (e.type === 'decision.changed' && e.decision.status === 'deferred') kickQueue?.()
      // A decision answered elsewhere or deferred ends the answer proposals still waiting on it.
      if (e.type === 'decision.changed' && e.decision.status !== 'pending') {
        void proposalService?.decisionSettled(e.decision).catch(() => {})
      }
      for (const listener of [...listeners]) {
        try {
          listener(e)
        } catch {
          // One bad listener must not stop the others or the engine.
        }
      }
    }

    // News for the orchestrator's turns of its own. The session it wakes exists below; nothing fires before start().
    let orchestratorSession: OrchestratorSession | null = null
    const wakeScheduler = new WakeScheduler({
      repo: repos.wakes,
      clock,
      wake: (rows) => orchestratorSession?.wake(rows) ?? Promise.resolve(),
      busy: () => orchestratorSession?.busy ?? true,
      usageLimitedUntil: () => usageGate?.limitedUntil() ?? null,
      canWake: async () => cfg.runtime !== null && (await repos.workspaces.list()).length > 0
    })
    wakeSchedulerRef = wakeScheduler
    const addWake = async (workspaceId: string, kind: WakeKind, ref: string): Promise<void> => {
      // Losing the news must never break what produced it; the board still shows it.
      // A removed workspace has nobody to tell.
      if ((await repos.workspaces.get(workspaceId)) === null) return
      if (await repos.wakes.add(workspaceId, kind, ref).catch(() => false)) wakeScheduler.added()
    }

    const holds = new HoldService({
      holds: repos.holds,
      tickets: repos.tickets,
      decisions: repos.decisions,
      clock,
      emit,
      onReleasedByDate: ({ workspaceId, hold, decision }) =>
        decision === null ? addWake(workspaceId, 'released_hold', hold.id) : addWake(workspaceId, 'resurfaced', decision.id)
    })

    // New branches start from the newest base; the monitor (below) measures open branches against it.
    const freshnessChecker = new BranchFreshnessChecker(cfg.git, cfg.commands ?? runCommand)
    const worktrees = new WorktreeManager(cfg.git, cfg.paths, repos.cleanups, undefined, undefined, async (ws) => {
      const base = await freshnessChecker.newestBase(ws, { fetch: true })
      // The fetch may have moved origin/<base>: the other open tickets are measured against it now (freshness exists by the time a ticket starts).
      void freshness.refresh(ws.id, { fetch: false }).catch(() => {})
      return { ref: base.ref, notice: base.notice }
    })
    const attachments = new Attachments({
      repo: repos.attachments,
      paths: cfg.paths,
      ticket: (id) => repos.tickets.get(id),
      workspace: (id) => repos.workspaces.get(id)
    })
    const orchestratorImages = new OrchestratorImages({ repo: repos.orchestratorImages, homeRoot: cfg.paths.root })
    const pullRequests = new PullRequestPublisher(cfg.commands ?? runCommand)
    // Created beside the runner it drives; it reads its stored state before anything can start (see below).
    const gate: UsageGate = (usageGate = new UsageGate({
      settings: repos.settings,
      clock,
      emit,
      ...(cfg.usageRetryMs !== undefined ? { retryMs: cfg.usageRetryMs } : {}),
      runner: {
        pauseForUsageLimit: (runId) => runner.pauseForUsageLimit(runId),
        releaseLimitPaused: () => runner.releaseLimitPaused(),
        probe: () => runner.probe(),
        limitPausedCount: () => runner.limitPausedCount(),
        kickQueue: () => runner.kickQueue()
      }
    }))
    const sweeper = cfg.processes ?? new ProcessSweeper()
    const runner: TicketRunner = new TicketRunner({
      repos,
      worktrees,
      runtime: cfg.runtime ?? missingRuntime,
      now,
      emit,
      unattended: (workspaceId) => modes.get(workspaceId)?.isOn() ?? false,
      usage: usageHooks(gate),
      pullRequests,
      reportFiles: new ReportFileSaver(cfg.commands ?? runCommand),
      processes: sweeper,
      setup: cfg.setupCommands ?? createSetupCommandRunner(sweeper),
      branchMoved: (workspaceId) => void freshness.refresh(workspaceId, { fetch: false }).catch(() => {}),
      onFailed: ({ workspaceId, runId }) => addWake(workspaceId, 'failure', runId),
      attachments: { sync: (ticketId, scratch) => attachments.sync(ticketId, scratch, { skipIfNone: true }) }
    })
    const stuckDetector = new StuckDetector({
      repos,
      now,
      emit,
      timer: cfg.stuck?.timer ?? realTimer,
      ...(cfg.stuck?.intervalMs !== undefined ? { intervalMs: cfg.stuck.intervalMs } : {}),
      observe: (ticketId) => runner.observeRun(ticketId),
      failIfExhausted: (ticketId, runId) => runner.failIfExhausted(ticketId, runId),
      noteStuck: (ticketId, runId, note) => runner.noteStuck(ticketId, runId, note),
      onStuck: (workspaceId, episode) => addWake(workspaceId, 'stuck', episode.id),
      newestChange: cfg.stuck?.newestChange ?? ((worktreePath) => newestChange(worktreePath))
    })
    const freshness = new FreshnessMonitor({
      repos,
      checker: freshnessChecker,
      now,
      emit,
      timer: cfg.freshness?.timer ?? realTimer,
      ...(cfg.freshness?.intervalMs !== undefined ? { intervalMs: cfg.freshness.intervalMs } : {})
    })
    await worktrees.recoverPendingCleanups()
    // Before recovery kicks the queue: a limit stored at the last quit must hold the agents back from the start.
    await gate.load()
    await runner.markAllNotAlive()
    kickQueue = () => runner.kickQueue()
    // Holds that came due while Mainbus was closed are released before anything can start a ticket.
    await holds.start()
    stuckDetector.start()
    // Not waited for: the first measurements arrive on the board when they are done.
    freshness.start()
    void freshness.refreshAll().catch(() => {})

    /** The workspace a renderer command is about: the one named, else the focused one. */
    const requireWorkspace = async (id?: string): Promise<Workspace> => {
      if (id !== undefined) {
        if (typeof id !== 'string') throw new Error('Unknown workspace')
        const named = await repos.workspaces.get(id)
        if (!named) throw new Error('Unknown workspace: it may have been removed')
        return named
      }
      const ws = await repos.workspaces.focused()
      if (!ws) throw new Error(WORKSPACE_REQUIRED)
      return ws
    }
    const requireRuntime = (): void => {
      if (cfg.runtime === null) throw new SetupRequiredError()
    }

    // The machine stays awake while any workspace's mode has work: a count, so one mode stopping does not let it sleep.
    const baseAwake = cfg.keepAwake ?? { start: () => {}, stop: () => {} }
    let awakeHolds = 0
    const keepAwake = {
      start: () => {
        if (awakeHolds++ === 0) baseAwake.start()
      },
      stop: () => {
        if (awakeHolds > 0 && --awakeHolds === 0) baseAwake.stop()
      }
    }

    // Whether each is on is stored per workspace, and restored once the agents are back (see recovery below).
    const modeFor = (ws: Workspace): UnattendedMode => {
      let mode = modes.get(ws.id)
      if (!mode) {
        mode = new UnattendedMode({
          workspaceId: ws.id,
          runner,
          tickets: () => repos.tickets.list(ws.id),
          checkCanRun: async () => {
            requireRuntime()
            await requireWorkspace(ws.id)
          },
          emit,
          limitedUntil: () => gate.limitedUntil(),
          held: () => holds.heldIds(),
          blocked: () => repos.dependencies.blockedIds(ws.id),
          keepAwake,
          now,
          remember: (on) => repos.workspaces.setUnattendedOn(ws.id, on),
          remembered: () => repos.workspaces.unattendedOn(ws.id)
        })
        modes.set(ws.id, mode)
      }
      return mode
    }
    for (const ws of await repos.workspaces.list()) modeFor(ws)
    /** The mode of the workspace this ticket is in, if it has one. */
    const modeOfTicket = async (ticketId: string): Promise<UnattendedMode | undefined> => {
      const ticket = await repos.tickets.get(ticketId).catch(() => null)
      return ticket ? modes.get(ticket.workspaceId) : undefined
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

      // The same repo again is the workspace it already is (a removed one comes back, board and all).
      const known = (await repos.workspaces.listAll()).find((w) => samePath(path.resolve(w.repoPath), root))
      if (known) {
        if (known.removed) await repos.workspaces.restore(known.id)
        const live = (await repos.workspaces.get(known.id))!
        modeFor(live)
        await repos.workspaces.setFocused(live.id)
        emit({ type: 'board.changed', workspaceId: live.id })
        emit({ type: 'workspaces.changed', focusedId: live.id })
        return live
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
      modeFor(workspace)
      await repos.workspaces.setFocused(workspace.id)
      emit({ type: 'board.changed', workspaceId: workspace.id })
      emit({ type: 'workspaces.changed', focusedId: workspace.id })
      return workspace
    }

    /** The ids of the tickets of the workspace that have an agent open, or are starting one. */
    async function ticketsWithOpenAgents(workspaceId: string): Promise<Ticket[]> {
      const open: Ticket[] = []
      for (const t of await repos.tickets.list(workspaceId)) {
        const latest = await repos.runs.latest(t.id)
        if ((latest && latest.endReason === null) || runner.isLaunching(t.id)) open.push(t)
      }
      return open
    }
    const numbers = (tickets: Ticket[]): string => tickets.map((t) => `#${t.number}`).join(', ')

    /**
     * Removes the workspace from Mainbus: its row stays (marked removed) so its tickets and history are not lost, and
     * the repo is never touched. Folders with uncommitted work are never removed; they are returned.
     */
    async function removeWorkspace(id: string): Promise<{ keptFolders: string[] }> {
      const ws = await repos.workspaces.get(id)
      if (!ws) throw new Error('Unknown workspace: it may have been removed already')
      const refuse = (open: Ticket[]): Error =>
        new Error(`${ws.name} has agents open on ${numbers(open)}. Stop them (or let them finish) first; nothing was removed.`)
      const open = await ticketsWithOpenAgents(id)
      if (open.length > 0) throw refuse(open)
      const tickets = await repos.tickets.list(id)
      const dirty: string[] = []
      for (const t of tickets) {
        if (t.worktreePath !== null && (await worktrees.isDirty(ws.repoPath, t.worktreePath))) dirty.push(`#${t.number} (${t.worktreePath})`)
      }
      if (dirty.length > 0) {
        throw new Error(`These folders have uncommitted changes: ${dirty.join(', ')}. Commit or discard them first; nothing was removed.`)
      }

      // First, so nothing new starts in it; an agent that slipped in meanwhile puts it back.
      await repos.workspaces.markRemoved(id)
      const slipped = await ticketsWithOpenAgents(id)
      if (slipped.length > 0) {
        await repos.workspaces.restore(id)
        throw refuse(slipped)
      }

      const mode = modes.get(id)
      if (mode) {
        await mode.set(false)
        mode.dispose()
        modes.delete(id)
      }
      await repos.workspaces.setUnattendedOn(id, false)
      for (const p of await repos.proposals.list()) {
        if (p.workspaceId !== id || p.status !== 'pending') continue
        const failed = await repos.proposals.failPending(p.id, 'Its workspace was removed')
        if (failed) emit({ type: 'proposal.changed', proposal: failed })
      }
      const wakes = (await repos.wakes.pending()).filter((w) => w.workspaceId === id)
      await repos.wakes.ack(wakes.map((w) => w.id))
      for (const t of tickets) await holds.unhold(t.id).catch(() => {})

      const keptFolders: string[] = []
      for (const t of tickets) {
        if (t.worktreePath === null || t.branch === null) continue
        try {
          const outcome = await worktrees.remove(t.id, ws.repoPath, t.worktreePath, t.branch, { discard: false })
          if (outcome === 'removed') await repos.tickets.setWorktree(t.id, t.branch, null)
          else keptFolders.push(t.worktreePath)
        } catch {
          // A folder a program holds open, or that is not a worktree any more: left as it is.
          keptFolders.push(t.worktreePath)
        }
      }
      // The images go with the workspace; the repo never had them.
      await attachments.removeWorkspace(ws).catch((err: unknown) => console.warn(`Mainbus could not remove ${ws.name}'s attachments: ${errorText(err)}`))
      emit({ type: 'workspaces.changed', focusedId: (await repos.workspaces.focused())?.id ?? null })
      return { keptFolders }
    }

    /**
     * The one way tickets are created: by the user (ticket.create), by an agent (intake), or from a proposal the
     * user confirmed. In order, all of them or none.
     */
    async function createTickets(
      ws: Workspace,
      inputs: TicketToCreate[],
      record?: { proposalId: string; column: DraftColumn }
    ): Promise<Ticket[]> {
      // The images the orchestrator attaches are checked and written first, and recorded with the tickets: all or none.
      const prepared = inputs.some((i) => i.images?.length) ? await attachments.prepareForNew(ws, await imagesToAttach(inputs)) : null
      let tickets: Ticket[]
      try {
        const known = new Set((await repos.tickets.list(ws.id)).map((t) => t.id))
        inputs.forEach((input, i) => {
          for (const b of input.blockedBy ?? []) {
            if ('draft' in b ? b.draft < 0 || b.draft >= i : !known.has(b.id)) {
              throw new ProposalInvalid(`A blocker of ticket ${i} isn't a ticket in ${ws.name} or an earlier ticket of this call`)
            }
          }
        })
        const at = now().toISOString()
        tickets = await repos.tickets.createMany(
          inputs.map(({ images: _images, blockedBy: _blockedBy, ...input }) => ({ ...input, workspaceId: ws.id })),
          (ids) => [
            ...(record ? [repos.proposals.ticketsResultStatement(record.proposalId, ids, record.column)] : []),
            ...(prepared?.statements(ids) ?? []),
            // The links go in the same batch: the tickets and their blockers are all or none.
            ...inputs.flatMap((input, i) =>
              insertDependencyStatements(
                handle.db,
                ids[i]!,
                [...new Set((input.blockedBy ?? []).map((b) => ('draft' in b ? ids[b.draft]! : b.id)))],
                at
              )
            )
          ]
        )
      } catch (err) {
        await prepared?.discard()
        throw err
      }
      await prepared
        ?.place(tickets)
        .catch((err: unknown) => console.warn(`Mainbus could not move the new tickets' images into place: ${errorText(err)}`))
      emit({ type: 'board.changed', workspaceId: ws.id })
      return tickets
    }
    // The user's and the agents' own tickets: only the orchestrator's carry its images.
    const createTicket = async (ws: Workspace, input: Omit<TicketToCreate, 'images'>): Promise<Ticket> =>
      (await createTickets(ws, [{ ...input, images: undefined }]))[0]!

    /** Each ticket's images to attach: the files of the images the user sent the orchestrator, read and checked again. */
    async function imagesToAttach(inputs: TicketToCreate[]): Promise<{ name: string; bytes: Uint8Array }[][]> {
      const read = new Map<string, { name: string; bytes: Uint8Array }>()
      for (const id of new Set(inputs.flatMap((i) => i.images ?? []))) {
        const { image, bytes } = await orchestratorImages.read(id).catch((err: unknown) => {
          throw new Error(`An image the user sent can't be attached: ${errorText(err)}`)
        })
        read.set(id, { name: image.filename, bytes })
      }
      return inputs.map((i) => (i.images ?? []).map((id) => read.get(id)!))
    }

    /**
     * "Ask the orchestrator to start an agent once it's in Ready": when a ticket with the flag is in Ready, its start is
     * proposed, once. A ticket that could not be proposed for stays in Ready, and the flag is spent.
     */
    const proposeStartIfAsked = async (ticketId: string): Promise<void> => {
      if (!(await repos.tickets.takeStartWhenReady(ticketId))) return
      try {
        await orchestrator.proposeStartWhenReady(await repos.tickets.get(ticketId))
      } catch {
        // The ticket is in Ready either way; the person can start it themselves.
      }
    }

    // The ticket view's Pause, Stop and Skip; a confirmed proposal goes through the same functions.
    // With `expect`, they fail rather than act on a role other than the one named.
    // Stopping needs no runtime: without one nothing is live, and a paused run can still be ended.
    // Stopping the ticket unattended mode is running turns the mode off: the user is here.
    const stopTicket = async (ticketId: string, expect?: RunExpectation): Promise<void> => {
      ;(await modeOfTicket(ticketId))?.userStopped(ticketId)
      return runner.stop(ticketId, expect)
    }
    // Like Stop: pausing needs no runtime, and pausing the ticket unattended mode is running turns the mode off.
    const pauseTicket = async (ticketId: string, expect?: RunExpectation): Promise<void> => {
      ;(await modeOfTicket(ticketId))?.userPaused(ticketId)
      return runner.pause(ticketId, expect)
    }
    const skipTicket = (ticketId: string, expect?: RunExpectation): Promise<void> => {
      requireRuntime()
      return runner.skip(ticketId, expect)
    }

    // The ticket view's Update from main; a confirmed proposal goes through the same functions.
    /** Why a ticket can't be updated from main right now, or null. Judged from the last freshness check. */
    const whyNotUpdatableNow = async (ticket: Ticket): Promise<string | null> => {
      const n = `#${ticket.number}`
      if (ticket.kind !== 'change') return `${n} is an Investigate ticket; Update from main is for Change tickets`
      if (ticket.manualColumn === 'done') return `${n} is Done`
      if (ticket.branch === null || ticket.worktreePath === null) return `${n} has no branch yet`
      const fresh = freshness.statusOf(ticket.id)
      if (fresh === null || fresh.behind === 0) return `${n} is not behind ${(await repos.workspaces.get(ticket.workspaceId))?.baseBranch ?? 'main'}`
      const { agentStatus, settingUp } = await runner.stateOf(ticket.id)
      if (agentStatus === 'working' || agentStatus === 'queued' || settingUp || runner.isLaunching(ticket.id)) {
        return `A role is working on ${n}; wait for it to hand off, or pause it first`
      }
      if (updateRoleOf(await repos.lineups.get(ticket.workspaceId, ticket.kind)) === null) {
        return `The Change lineup has no Implementer, so there is no role to merge main`
      }
      return null
    }
    /**
     * Ends the ticket's open run, if there is one, and starts the Implementer-only Update run. `expect` is the open run the
     * caller saw (null: none was open); without it the open run, whichever it is, ends.
     */
    const updateFromMain = async (ticketId: string, expect?: RunExpectation | null): Promise<void> => {
      requireRuntime()
      const ticket = await repos.tickets.get(ticketId)
      const ws = await requireWorkspace(ticket.workspaceId)
      // Measured now, so the instructions name what main looks like at this moment.
      await freshness.refresh(ws.id)
      const why = await whyNotUpdatableNow(ticket)
      if (why !== null) throw new Error(why)
      const fresh = freshness.statusOf(ticketId)!
      const base = await freshnessChecker.newestBase(ws, { fetch: false })
      const lineup = await repos.lineups.get(ws.id, ticket.kind)
      const role = updateRoleOf(lineup)!
      // The model and effort the ticket's saved run settings give this role.
      const chosen = applyRunSettings(ticket.runSettings, lineup).options.roles?.[role.id]
      const lockfileChanged = ws.setupCommand !== '' && (await freshnessChecker.differs(ws.repoPath, ticket.branch!, base.sha, LOCKFILES))
      ;(await modeOfTicket(ticketId))?.userStopped(ticketId)
      await runner.updateFromMain(
        ticketId,
        {
          roleId: role.id,
          extraInstructions: updateInstructions({ ref: base.ref, sha: base.sha, behind: fresh.behind, conflicts: fresh.conflicts, lockfileChanged }),
          notice: `Update from main: the ${role.name} merges ${base.ref}, which has ${fresh.behind} commit${fresh.behind === 1 ? '' : 's'} this branch lacks${fresh.conflicts.length > 0 ? ` (conflicts in ${fresh.conflicts.join(', ')})` : ''}.`,
          setupAgain: lockfileChanged,
          ...(chosen ? { roles: { [role.id]: chosen } } : {})
        },
        expect
      )
    }

    // The ticket view's Promote; a confirmed proposal goes through the same functions.
    const promoting = new Set<string>()
    const whyNotPromotableNow = async (ticket: Ticket): Promise<string | null> =>
      whyNotPromotable(ticket, (await runner.stateOf(ticket.id)).column, await repos.tickets.promotedTo(ticket.id))
    const draftPromotion = async (ticket: Ticket) =>
      draftPromotionSpec(cfg.runtime ?? missingRuntime, cfg.paths, ticket, cfg.promoteSummaryTimeoutMs ?? SKIP_SUMMARY_MS)
    /** The one way a ticket moves to Done: the ticket view's move, and a promotion's. 'dirty' leaves it where it was. */
    const moveTicketToDone = async (id: string): Promise<'moved' | 'dirty'> => {
      ;(await modeOfTicket(id))?.userMoved(id, 'done')
      const wasDone = (await repos.tickets.get(id)).manualColumn === 'done'
      const moved = (await runner.moveToDone(id)) === 'done'
      // A Done ticket has nothing left to hold back.
      if (moved) await holds.unhold(id)
      if (moved && !wasDone) await noteUnblocked(id)
      // Main may have just moved: the open tickets are measured against it again.
      if (moved) void freshness.refresh((await repos.tickets.get(id)).workspaceId).catch(() => {})
      return moved ? 'moved' : 'dirty'
    }
    /** After a ticket reached Done: each ticket it was the last open blocker of is noted as unblocked (its Activity, the orchestrator's next turn). */
    async function noteUnblocked(doneId: string): Promise<void> {
      let any = false
      let workspaceId: string | null = null
      for (const dependentId of await repos.dependencies.dependentsOf(doneId)) {
        const dependent = await repos.tickets.get(dependentId)
        if (dependent.manualColumn === 'done') continue
        const blockers = await repos.dependencies.blockersOf(dependentId)
        if (blockers.length === 0 || openBlockers(blockers).length > 0) continue
        await repos.dependencies.addNote(dependentId, { kind: 'unblocked', blockers: blockers.map((b) => ({ number: b.number, title: b.title })), via: null })
        any = true
        workspaceId = dependent.workspaceId
      }
      if (any && workspaceId) emit({ type: 'board.changed', workspaceId })
    }
    /**
     * The one way a ticket is started by the user or a confirmed proposal. A ticket with blockers that aren't Done is refused
     * unless `startAnyway`; starting anyway is recorded in its Activity. (Unattended mode skips blocked tickets and never gets here.)
     */
    const startChecked = async (ticketId: string, opts: StartOptions | undefined, via: 'ticket' | 'proposal'): Promise<void> => {
      requireRuntime()
      const { startAnyway, ...rest } = opts ?? {}
      const open = openBlockers(await repos.dependencies.blockersOf(ticketId))
      if (open.length > 0 && !startAnyway) throw new Error(`${notDoneYetText(open)}, so it can't start yet`)
      await runner.start(ticketId, opts === undefined ? undefined : rest)
      if (open.length > 0) {
        await repos.dependencies.addNote(ticketId, { kind: 'started_blocked', blockers: open.map((b) => ({ number: b.number, title: b.title })), via })
        emit({ type: 'board.changed', workspaceId: (await repos.tickets.get(ticketId)).workspaceId })
      }
    }
    async function promoteTicket(ticketId: string, input: { title: string; spec: string }): Promise<Ticket> {
      // The renderer is untrusted: the same rules as any ticket's fields.
      const fields = z.strictObject({ title: ticketFields.title, spec: ticketFields.spec }).parse(input)
      if (promoting.has(ticketId)) throw new Error('This ticket is already being promoted')
      promoting.add(ticketId)
      try {
        const original = await repos.tickets.get(ticketId)
        const why = await whyNotPromotableNow(original)
        if (why !== null) throw new Error(why)
        // Done first: if creating the Change ticket then fails, Promote still works from Done.
        if (original.manualColumn !== 'done' && (await moveTicketToDone(ticketId)) === 'dirty') {
          throw new Error(`#${original.number}'s folder has uncommitted changes, so it can't move to Done; nothing was promoted`)
        }
        const moved = await repos.tickets.get(ticketId)
        // Whatever spec was confirmed, it names the report's file in the repo.
        const created = await repos.tickets.createPromoted(moved, { ...fields, spec: withReportFile(fields.spec, moved) })
        // The promoted ticket's agents get the same images; a failed copy doesn't undo the promotion.
        await attachments.copyAll(original, created).catch((err: unknown) => console.warn(`Mainbus could not copy #${original.number}'s attachments: ${errorText(err)}`))
        emit({ type: 'board.changed', workspaceId: created.workspaceId })
        return created
      } finally {
        promoting.delete(ticketId)
      }
    }

    // Confirmed proposals are carried out here, by engine code, never by the orchestrator.
    const proposals = (proposalService = createProposalService({
      repo: repos.proposals,
      emit,
      exec: {
        workspace: (id) => repos.workspaces.get(id),
        orchestratorFolder: orchestratorFolder(cfg.paths.root),
        createTickets,
        lineup: (workspaceId, kind) => repos.lineups.get(workspaceId, kind),
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
        // A proposal the user confirmed over a blocker is a start anyway; startLineup checks that it said so.
        startTicket: (ticketId, opts) => startChecked(ticketId, { ...opts, startAnyway: true }, 'proposal'),
        async openBlockers(ticket) {
          return openBlockers(await repos.dependencies.blockersOf(ticket.id))
        },
        async activeRole(ticket) {
          return runner.activeRole(ticket.id)
        },
        pauseTicket,
        openStuckEpisode: (runId) => repos.stuck.open(runId),
        redirectTicket: (ticketId, expect, message, proposalId) => {
          requireRuntime()
          return runner.redirect(ticketId, { agentRunId: expect.agentRunId }, message, async () => {
            const open = await repos.stuck.open(expect.agentRunId)
            return open?.id === expect.episodeId && (await repos.stuck.markRedirected(expect.episodeId))
          }, proposalId)
        },
        replaceTicket: (ticketId, expect, request) => {
          requireRuntime()
          return runner.replace(ticketId, expect, request)
        },
        stopTicket,
        skipTicket,
        now,
        holdTicket: (ticketId, opts) => holds.hold(ticketId, opts),
        whyNotPromotable: whyNotPromotableNow,
        whyNotUpdatable: whyNotUpdatableNow,
        freshnessOf: (ticket) => freshness.statusOf(ticket.id),
        updateFromMain: (ticketId, expect) => updateFromMain(ticketId, expect),
        draftPromotionSpec: draftPromotion,
        promoteTicket,
        async decision(id) {
          const decision = await repos.decisions.get(id).catch(() => null)
          const ticket = decision && (await repos.tickets.get(decision.ticketId).catch(() => null))
          return decision && ticket ? { decision, ticket } : null
        },
        answerDecision: (id, a) => {
          requireRuntime()
          return runner.answer(id, a, 'orchestrator')
        }
      }
    }))

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
      const lineups = new Map<Lineup, Promise<LineupRole[]>>()
      const workspaceLineup = (kind: Lineup) => {
        let lineup = lineups.get(kind)
        if (!lineup) lineups.set(kind, (lineup = repos.lineups.get(ws.id, kind)))
        return lineup
      }
      const stuckOf = await repos.stuck.openByTicket()
      const attached = await repos.attachments.listForWorkspace(ws.id)
      const edited = await repos.ticketEdits.listForWorkspace(ws.id)
      const blockedBy = await repos.dependencies.forWorkspace(ws.id)
      const dependencyNotes = await repos.dependencies.notesForWorkspace(ws.id)
      return Promise.all(
        tickets.map(async (t) => ({
          ...t,
          ...(await runner.boardView(t.id, () => workspaceLineup(t.kind))),
          hold: holdOf.get(t.id) ?? null,
          stuck: stuckOf.get(t.id) ?? null,
          freshness: freshness.statusOf(t.id),
          attachments: attached.filter((a) => a.ticketId === t.id),
          blockedBy: blockedBy.get(t.id) ?? [],
          dependencyNotes: dependencyNotes.get(t.id) ?? [],
          edits: edited
            .filter((e) => e.ticketId === t.id)
            .map(({ id, at, fields, intentAdded, undoneAt }) => ({ id, at, fields, userWords: intentAdded.length, undoneAt })),
          // Worked out on each read and never written back: they show until the user saves or resets.
          runSettingsNotices: t.runSettings === null ? [] : applyRunSettings(t.runSettings, await workspaceLineup(t.kind)).notices
        }))
      )
    }

    /** Saves a ticket's run settings, checked against its own lineup, whenever no run is open: before the first start, or after a run has ended. */
    const setRunSettings = async (id: string, input: RunSettingsInput | null): Promise<Ticket> => {
      const ticket = await repos.tickets.get(id)
      const latest = await repos.runs.latest(id)
      if ((latest && latest.endReason === null) || runner.isLaunching(id)) throw new Error("Run settings can't be changed while a run is open")
      const settings = input === null ? null : checkRunSettings(input, await repos.lineups.get(ticket.workspaceId, ticket.kind))
      const saved = await repos.tickets.setRunSettings(id, settings)
      emit({ type: 'board.changed', workspaceId: saved.workspaceId })
      return saved
    }

    /** The blockers for this ticket, checked against its workspace's tickets and links: their ids, or the reason they are refused. */
    const checkedBlockers = async (ticket: Ticket, ids: string[]): Promise<string[] | string> => {
      const checked = checkBlockers(ticket.id, ids, await repos.tickets.list(ticket.workspaceId), await repos.dependencies.edges(ticket.workspaceId))
      return checked.ok ? checked.ids : checked.reason
    }
    const resolveBlockerNumbers = async (ws: Workspace, ticket: Ticket, numbers: number[]): Promise<string[] | string> => {
      const ids: string[] = []
      for (const n of numbers) {
        const found = await repos.tickets.byNumber(ws.id, n)
        if (!found) return `There is no ticket #${n} in ${ws.name}`
        ids.push(found.id)
      }
      return checkedBlockers(ticket, ids)
    }

    /** Tickets being edited or having an edit undone, so two of them never overlap. */
    const editing = new Set<string>()
    const withEditGuard = async <T>(ticketId: string, step: () => Promise<T>): Promise<T> => {
      if (editing.has(ticketId)) throw new Error('This ticket is being edited right now')
      editing.add(ticketId)
      try {
        return await step()
      } finally {
        editing.delete(ticketId)
      }
    }
    const whyNotEditableNow = async (ticket: Ticket): Promise<string | null> => {
      const latest = await repos.runs.latest(ticket.id)
      const runOpen = (latest !== null && latest.endReason === null) || runner.isLaunching(ticket.id)
      return whyNotEditable(ticket, (await runner.stateOf(ticket.id)).column, runOpen)
    }

    /**
     * The orchestrator's update_ticket, at the user's request: the ticket's title, spec, criteria and labels, and the user's
     * own messages appended to its intent. The record of it is what the panel's receipt and Undo use.
     */
    const editByOrchestrator = async (
      ws: Workspace,
      input: EditInput,
      ctx: { userWords: string[]; orchestratorRunId: string }
    ): Promise<{ edit: TicketEdit; title: string }> => {
      const ticket = await repos.tickets.byNumber(ws.id, input.ticket)
      if (!ticket) throw new Error(`There is no ticket #${input.ticket} in ${ws.name}`)
      return withEditGuard(ticket.id, async () => {
        const why = await whyNotEditableNow(ticket)
        if (why !== null) throw new Error(why)
        const current = await repos.dependencies.blockersOf(ticket.id)
        const plan = planEdit(ticket, input, current.map((b) => b.number))
        // Checked before anything is written, so a refusal changes nothing.
        let blockedBy: string[] | undefined
        if (plan.after.blockedBy) {
          const resolved = await resolveBlockerNumbers(ws, ticket, plan.after.blockedBy)
          if (typeof resolved === 'string') throw new ProposalInvalid(resolved)
          blockedBy = resolved
        }
        const edit = await repos.ticketEdits.apply({
          ...(blockedBy ? { blockedBy } : {}),
          ticketId: ticket.id,
          workspaceId: ws.id,
          orchestratorRunId: ctx.orchestratorRunId,
          patch: plan.patch,
          fields: plan.fields,
          before: plan.before,
          after: plan.after,
          userWords: ctx.userWords
        })
        emit({ type: 'board.changed', workspaceId: ws.id })
        emit({ type: 'ticketEdit.changed', edit })
        return { edit, title: plan.after.title ?? ticket.title }
      })
    }

    /** Undo of an orchestrator edit, refused with the reason when the ticket changed or started since. */
    const undoEdit = async (editId: string): Promise<TicketEdit> => {
      const edit = await repos.ticketEdits.get(editId)
      return withEditGuard(edit.ticketId, async () => {
        if (edit.undoneAt !== null) throw new Error(`The edit of #${edit.number} is already undone`)
        const ticket = await repos.tickets.get(edit.ticketId)
        const why = await whyNotEditableNow(ticket)
        if (why !== null) throw new Error(`Can't undo: ${why}`)
        const latest = await repos.runs.latest(ticket.id)
        if (latest !== null && latest.startedAt > edit.at) throw new Error(`Can't undo: #${edit.number} was started since this edit`)
        let undone: TicketEdit
        try {
          let blockedBy: string[] | undefined
          if (edit.before.blockedBy) {
            // A ticket that is gone is dropped; a loop it would now make refuses the Undo.
            const found = await Promise.all(edit.before.blockedBy.map((n) => repos.tickets.byNumber(edit.workspaceId, n)))
            const resolved = await checkedBlockers(ticket, found.filter((t): t is Ticket => t !== null).map((t) => t.id))
            if (typeof resolved === 'string') throw new Error(`Can't undo: ${resolved}`)
            blockedBy = resolved
          }
          undone = await repos.ticketEdits.undo(edit, blockedBy)
        } catch (err) {
          if (err instanceof EditChangedError) throw new Error(`Can't undo: ${err.message}`)
          throw err
        }
        emit({ type: 'board.changed', workspaceId: edit.workspaceId })
        emit({ type: 'ticketEdit.changed', edit: undone })
        return undone
      })
    }

    /** What the renderer is told of an attachment: never where its file is. */
    const withoutPath = ({ path: _path, ...a }: AttachmentWithPath) => a

    /**
     * After an attachment was added or removed: the board shows it, the scratch folder's copies follow, and the ticket's
     * working agent is told in a short message, queued like the user's own (so it never interrupts a turn).
     */
    const attachmentChanged = async (change: 'attached' | 'removed', a: AttachmentWithPath): Promise<void> => {
      const ticket = await repos.tickets.get(a.ticketId)
      emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
      if (ticket.worktreePath === null) return
      const copies = await attachments.sync(ticket.id, scratchPathFor(cfg.paths, ticket.worktreePath)).catch(() => [])
      const copy = copies.find((c) => c.filename === a.filename)
      const text =
        change === 'removed'
          ? `The user removed the attachment ${a.filename}; its copy is gone from your scratch folder.`
          : copy
            ? `The user attached ${a.filename}: ${copy.path}`
            : null
      if (text !== null) void runner.announce(ticket.id, text).catch(() => {})
    }

    /** The New ticket dialog's images: all checked before the ticket exists, so a refused one creates nothing. */
    const checkNewAttachments = (files: unknown): { name: string; bytes: Uint8Array }[] => {
      if (files === undefined) return []
      if (!Array.isArray(files)) throw new Error('Attachments must be a list')
      const why = attachments.check(files as { name: string; bytes: unknown }[], 0)
      if (why !== null) throw new Error(why)
      return files as { name: string; bytes: Uint8Array }[]
    }

    /** What a wake row says now, or null when its run, episode, hold, decision or ticket is gone. */
    async function wakeItemOf(row: Wake): Promise<WakeItem | null> {
      const workspace = (await repos.workspaces.get(row.workspaceId))?.name
      if (workspace === undefined) return null
      const item = await wakeItemIn(row)
      if (item === null) return null
      return item.kind === 'stuck' ? { ...item, report: { ...item.report, workspace } } : { ...item, workspace }
    }
    async function wakeItemIn(row: Wake): Promise<WakeItem | null> {
      switch (row.kind) {
        case 'failure': {
          const run = await repos.runs.get(row.ref)
          const ticket = run && (await repos.tickets.get(run.ticketId).catch(() => null))
          if (!run || !ticket) return null
          const errors = (await repos.runs.events(run.id)).filter((e) => e.event.kind === 'error')
          const last = errors.at(-1)?.event
          return { kind: 'failure', number: ticket.number, title: ticket.title, role: run.role, error: last?.kind === 'error' ? last.message : null }
        }
        case 'stuck': {
          const found = await repos.stuck.byId(row.ref)
          const ticket = found && (await repos.tickets.get(found.ticketId).catch(() => null))
          if (!found || !ticket) return null
          return { kind: 'stuck', report: stuckReportOf(ticket.number, ticket.title, found.role, found.episode), open: found.open }
        }
        case 'released_hold': {
          const hold = await repos.holds.get(row.ref)
          const ticket = hold && (await repos.tickets.get(hold.targetId).catch(() => null))
          return hold && ticket ? { kind: 'released_hold', number: ticket.number, title: ticket.title, until: hold.until } : null
        }
        case 'resurfaced': {
          const decision = await repos.decisions.get(row.ref).catch(() => null)
          const ticket = decision && (await repos.tickets.get(decision.ticketId).catch(() => null))
          if (!decision || !ticket) return null
          return { kind: 'resurfaced', number: ticket.number, title: ticket.title, question: decision.question, decisionId: decision.id, stillOpen: decision.status === 'pending' }
        }
      }
    }
    /** The refs of this kind that a wake turn presented since `since`: the "Since your last turn" blocks leave them out. */
    const wakesPresented = async (kind: WakeKind, since: string | null): Promise<Set<string>> =>
      new Set((await repos.wakes.presentedSince(since)).filter((w) => w.kind === kind).map((w) => w.ref))

    // Its events never reach unattended mode as board changes: the orchestrator is not a ticket.
    const stuckReportOf = (number: number, title: string, role: string, episode: StuckEpisode): StuckReport => ({
      number,
      title,
      role,
      evidence: episode.evidence,
      hitCount: episode.hitCount,
      needsCloserLook: episode.needsCloserLook,
      redirected: episode.redirectedAt !== null,
      firedAgain: firedAgainAfterRedirect(episode)
    })

    const orchestrator = (orchestratorSession = new OrchestratorSession({
      repo: repos.orchestrator,
      runtime: cfg.runtime ?? missingRuntime,
      homeRoot: cfg.paths.root,
      paths: cfg.paths,
      now,
      emit,
      focused: () => repos.workspaces.focused(),
      workspaces: () => repos.workspaces.list(),
      decisionWorkspace: async (id) => {
        const decision = await repos.decisions.get(id).catch(() => null)
        const ticket = decision && (await repos.tickets.get(decision.ticketId).catch(() => null))
        return ticket ? ticket.workspaceId : null
      },
      workspaceRequired: WORKSPACE_REQUIRED,
      readTools: createReadTools({
        repos,
        focused: () => repos.workspaces.focused(),
        list: () => repos.workspaces.list(),
        board: boardView,
        usage: () => gate.state(),
        attachments: (ticketId) => attachments.list(ticketId)
      }),
      proposals,
      images: orchestratorImages,
      createTickets: (ws, inputs) => createTickets(ws, inputs),
      editTicket: editByOrchestrator,
      edits: () => repos.ticketEdits.listAll(),
      answeredSince: async (since) => {
        const answered: AnsweredDecision[] = []
        for (const ws of await repos.workspaces.list()) {
          for (const a of await repos.decisions.answeredSince(ws.id, since)) answered.push({ ...a, workspace: ws.name })
        }
        return answered
      },
      ticketByNumber: (workspaceId, number) => repos.tickets.byNumber(workspaceId, number),
      unblockedSince: async (since) => {
        const unblocked: UnblockedTicket[] = []
        for (const n of await repos.dependencies.unblockedSince(since)) {
          const ticket = await repos.tickets.get(n.ticketId).catch(() => null)
          const ws = ticket && (await repos.workspaces.get(ticket.workspaceId))
          if (ticket && ws) unblocked.push({ number: ticket.number, title: ticket.title, workspace: ws.name, blockers: n.blockers })
        }
        return unblocked
      },
      releasedSince: async (since) => {
        const released: ReleasedHold[] = []
        const presented = await wakesPresented('released_hold', since)
        for (const h of await repos.holds.releasedSince('ticket', since)) {
          if (presented.has(h.id)) continue
          const ticket = await repos.tickets.get(h.targetId).catch(() => null)
          const ws = ticket && (await repos.workspaces.get(ticket.workspaceId))
          if (ticket && ws && h.releasedAt !== null) {
            released.push({ number: ticket.number, title: ticket.title, workspace: ws.name, until: h.until, releasedAt: h.releasedAt })
          }
        }
        return released
      },
      resurfacedSince: async (since) => {
        const resurfaced: ResurfacedDecision[] = []
        const presented = await wakesPresented('resurfaced', since)
        for (const h of await repos.holds.releasedSince('decision', since)) {
          if (presented.has(h.targetId)) continue
          // Only those whose date came: an answer or Bring back released the others.
          if (h.until === null || h.releasedAt === null || h.until > h.releasedAt) continue
          const decision = await repos.decisions.get(h.targetId).catch(() => null)
          if (decision?.status !== 'pending') continue
          const ticket = await repos.tickets.get(decision.ticketId).catch(() => null)
          const ws = ticket && (await repos.workspaces.get(ticket.workspaceId))
          if (ticket && ws) {
            resurfaced.push({ number: ticket.number, title: ticket.title, workspace: ws.name, question: decision.question, until: h.until })
          }
        }
        return resurfaced
      },
      stuckSince: async (since) => {
        const reports: StuckReport[] = []
        const presented = await wakesPresented('stuck', since)
        for (const { ticketId, role, episode } of await repos.stuck.changedSince(since)) {
          if (presented.has(episode.id)) continue
          const ticket = await repos.tickets.get(ticketId).catch(() => null)
          const ws = ticket && (await repos.workspaces.get(ticket.workspaceId))
          if (!ticket || !ws) continue
          reports.push({ ...stuckReportOf(ticket.number, ticket.title, role, episode), workspace: ws.name })
        }
        return reports
      },
      wakes: repos.wakes,
      usage: { rateLimit: (event, runId) => gate.rateLimit(event, runId), hit: (limit, runId) => gate.hit(limit, runId) },
      wakeItems: async (rows) => {
        const presented: { row: Wake; item: WakeItem }[] = []
        const gone: Wake[] = []
        for (const row of rows) {
          const item = await wakeItemOf(row)
          if (item === null) gone.push(row)
          else presented.push({ row, item })
        }
        const open: OpenDecision[] = []
        for (const ws of await repos.workspaces.list()) {
          for (const { number, title, decision } of await repos.decisions.openIn(ws.id)) {
            open.push({
              workspace: ws.name,
              id: decision.id,
              number,
              title,
              question: decision.question,
              status: decision.status === 'deferred' ? 'deferred' : 'pending',
              deferredUntil: decision.deferredUntil
            })
          }
        }
        return { presented, gone, open }
      },
      onTurnEnded: (finished) => void wakeScheduler.turnEnded(finished)
    }))
    await wakeScheduler.start()

    // Restart recovery runs in the background, so the window and the board (read from the DB) don't wait for the
    // sweep of leftover processes: agents that were working resume, queued ones start, then unattended mode comes back.
    const recovery = runner
      .recover({ resume: cfg.runtime !== null })
      // Timers and the reset that passed while closed: after recovery (which skips the paused agents), before the mode.
      .then(() => (cfg.runtime !== null ? gate.start() : undefined))
      .then(() => Promise.all([...modes.values()].map((m) => m.restore())))
      .catch((err: unknown) => console.warn(`Mainbus could not finish restart recovery: ${err instanceof Error ? err.message : String(err)}`))

    const handlers: Handlers = {
      'setup.check': async () => {
        const setup = await resolveClaude(cfg.exec)
        // Claude was fixed after launch: the runtime is chosen once, at startup.
        if (setup.ok && cfg.runtime === null) {
          return { ok: false, reason: 'restart_required', detail: 'Restart Mainbus to use Claude Code.' }
        }
        return setup
      },
      'workspace.get': () => repos.workspaces.focused(),
      'workspace.list': () => repos.workspaces.list(),
      'workspace.summaries': async () => {
        return Promise.all(
          (await repos.workspaces.list()).map(async (ws) => ({
            ...ws,
            ...railCounts(await boardView(ws), runner.isRecovering())
          }))
        )
      },
      'workspace.open': openWorkspace,
      'workspace.focus': async (id) => {
        const ws = await requireWorkspace(id)
        await repos.workspaces.setFocused(ws.id)
        emit({ type: 'workspaces.changed', focusedId: ws.id })
        return ws
      },
      'workspace.remove': (id) => removeWorkspace(id),
      // Reached only through `invoke` (the renderer's IPC), like ticket.openPr and unattended.set.
      'workspace.setOpenPrOnReview': async (on, workspaceId) => {
        const ws = await repos.workspaces.setOpenPrOnReview((await requireWorkspace(workspaceId)).id, on === true)
        emit({ type: 'board.changed', workspaceId: ws.id })
        return ws
      },
      // Renderer-only too: the agent intake has no way to make Mainbus commit.
      'workspace.setReportSettings': async (settings, workspaceId) => {
        const input = z
          .strictObject({ saveReports: z.boolean().optional(), reportsFolder: z.string().max(500).optional() })
          .parse(settings)
        const ws = await repos.workspaces.setReportSettings((await requireWorkspace(workspaceId)).id, input)
        emit({ type: 'board.changed', workspaceId: ws.id })
        return ws
      },
      // Renderer-only: this command runs outside the permission guard, so no agent can set it.
      'workspace.setSetupSettings': async (settings, workspaceId) => {
        const input = z
          .strictObject({ command: z.string().max(2000).optional(), timeoutMinutes: z.number().optional() })
          .parse(settings)
        const ws = await repos.workspaces.setSetupSettings((await requireWorkspace(workspaceId)).id, input)
        emit({ type: 'board.changed', workspaceId: ws.id })
        return ws
      },
      'github.check': async (workspaceId) => pullRequests.checkGh((await requireWorkspace(workspaceId)).repoPath),

      'board.get': async (workspaceId) => {
        const ws = workspaceId === undefined ? await repos.workspaces.focused() : await requireWorkspace(workspaceId)
        return { tickets: ws ? await boardView(ws) : [] }
      },

      // The user's own words: never marked as agent-written, whatever the renderer sends.
      'ticket.create': async ({ attachments: files, ...input }, workspaceId) => {
        const ws = await requireWorkspace(workspaceId)
        const images = checkNewAttachments(files)
        const blockerIds = input.blockedBy ?? []
        if (blockerIds.length > 0) {
          const known = await repos.tickets.list(ws.id)
          const checked = checkBlockers(null, blockerIds, known, new Map())
          if (!checked.ok) throw new Error(checked.reason)
        }
        const ticket = await createTicket(ws, {
          ...input,
          blockedBy: undefined,
          ...(blockerIds.length > 0 ? { blockedBy: blockerIds.map((id) => ({ id })) } : {}),
          kind: input.kind === 'investigate' ? 'investigate' : 'change',
          source: undefined,
          via: undefined,
          intentAdded: undefined,
          agentContext: undefined
        })
        for (const image of images) {
          try {
            await attachments.add(ticket.id, image.name, image.bytes)
          } catch (err) {
            emit({ type: 'board.changed', workspaceId: ws.id })
            throw new Error(`#${ticket.number} was created, but ${image.name} couldn't be attached: ${errorText(err)}`)
          }
        }
        if (images.length > 0) emit({ type: 'board.changed', workspaceId: ws.id })
        if (input.column === 'ready') await proposeStartIfAsked(ticket.id)
        return ticket
      },
      'attachment.add': async (ticketId, name, bytes) => {
        const added = await attachments.add(ticketId, name, bytes)
        await attachmentChanged('attached', added)
        return withoutPath(added)
      },
      'attachment.remove': async (id) => {
        const removed = await attachments.remove(id)
        if (removed) await attachmentChanged('removed', removed)
      },
      'attachment.list': async (ticketId) => (await attachments.list(ticketId)).map(withoutPath),
      'attachment.data': (id) => attachments.dataUrl(id),
      'ticket.update': async (id, patch) => {
        const ticket = await repos.tickets.update(id, patch)
        emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
        return ticket
      },
      // Reached only through `invoke` (the renderer's IPC): the user edits blockers at any time, even when a run is open.
      'ticket.setBlockedBy': async (id, blockerIds) => {
        const ticket = await repos.tickets.get(id)
        const checked = await checkedBlockers(ticket, blockerIds)
        if (typeof checked === 'string') throw new Error(checked)
        await handle.db.batch(replaceDependencyStatements(handle.db, id, checked, now().toISOString()) as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
        emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
        return repos.tickets.get(id)
      },
      'ticket.appendIntent': async (id, text) => {
        const ticket = await repos.tickets.appendIntent(id, text)
        emit({ type: 'board.changed', workspaceId: ticket.workspaceId })
        return ticket
      },
      // Reached only through `invoke` (the renderer's IPC): only the user undoes the orchestrator's edit.
      'ticket.undoEdit': (editId) => undoEdit(editId),
      'ticket.move': async (id, column) => {
        if (column === 'done') return moveTicketToDone(id)
        ;(await modeOfTicket(id))?.userMoved(id, column)
        await runner.moveToColumn(id, column)
        if (column === 'ready') await proposeStartIfAsked(id)
        return 'moved'
      },
      'ticket.draftPromotion': async (id) => {
        const ticket = await repos.tickets.get(id)
        const why = await whyNotPromotableNow(ticket)
        if (why !== null) throw new Error(why)
        return { title: ticket.title, ...(await draftPromotion(ticket)) }
      },
      'ticket.promote': (id, fields) => promoteTicket(id, fields),
      'ticket.hold': (id, opts) => holds.hold(id, opts),
      'ticket.unhold': (id) => holds.unhold(id),
      'ticket.setRunSettings': (id, settings) => setRunSettings(id, settings),
      'ticket.openPr': (id) => runner.openPr(id),
      'ticket.saveReport': (id) => runner.saveReport(id),
      'ticket.runSetup': (id) => runner.runSetupAgain(id),
      'ticket.updateFromMain': (id) => updateFromMain(id),

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
        await startChecked(ticketId, opts, 'ticket')
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

      'lineup.get': async (lineup = 'change', workspaceId) => repos.lineups.get((await requireWorkspace(workspaceId)).id, knownLineup(lineup)),
      // The board changes too: before a ticket's first run, its lineup strip is the workspace lineup.
      'lineup.save': async (roles, lineup = 'change', workspaceId) => {
        const ws = await requireWorkspace(workspaceId)
        const saved = await repos.lineups.save(ws.id, roles, knownLineup(lineup))
        emit({ type: 'board.changed', workspaceId: ws.id })
        return saved
      },

      'allowRules.list': async (workspaceId) => {
        const ws = workspaceId === undefined ? await repos.workspaces.focused() : await requireWorkspace(workspaceId)
        return ws ? repos.allowRules.list(ws.id) : []
      },
      'allowRules.remove': (id) => repos.allowRules.remove(id),

      'agents.launcher': () => {
        if (!cfg.launcher) return null
        const intakeError = cfg.intakeError?.() ?? null
        return intakeError === null ? cfg.launcher : { ...cfg.launcher, intakeError }
      },

      // Reached only through `invoke` (the renderer's IPC); the intake handler below has no way to it.
      'settings.get': () => repos.settings.get(),
      'settings.setMaxAgents': async (n) => {
        const settings = await repos.settings.setMaxAgents(n)
        // A higher cap may let queued agents start; a lower one waits for the count to fall.
        runner.kickQueue()
        return settings
      },

      'settings.setWhenClosed': (v) => repos.settings.setWhenClosed(v),
      'settings.setTheme': async (v) => {
        const settings = await repos.settings.setTheme(v)
        emit({ type: 'theme.changed', theme: settings.theme })
        return settings
      },
      'settings.setMatchWindowsTheme': async (scheme, id) => {
        const settings = await repos.settings.setMatchWindowsTheme(scheme, id)
        emit({ type: 'theme.changed', theme: settings.theme })
        return settings
      },

      'unattended.get': async (workspaceId) => {
        // Before any workspace is open there is nothing to run.
        const ws = workspaceId === undefined ? await repos.workspaces.focused() : await requireWorkspace(workspaceId)
        return ws ? modeFor(ws).get() : { on: false, status: { kind: 'off' } }
      },
      'unattended.set': async (on, workspaceId) => modeFor(await requireWorkspace(workspaceId)).set(on === true),

      // Reached only through `invoke` (the renderer's IPC), like unattended.set.
      'usage.get': () => gate.state(),
      'usage.resumeNow': () => gate.resumeNow(),

      // Reached only through `invoke` (the renderer's IPC). Like Stop, stopping and reading need no runtime.
      'orchestrator.get': () => orchestrator.get(),
      'orchestrator.send': (text, images) => {
        requireRuntime()
        return orchestrator.send(text, images)
      },
      'orchestrator.image': (id) => orchestratorImages.dataUrl(id),
      'orchestrator.stop': () => orchestrator.stop(),
      // They act on the ticket's own workspace, whichever one is focused.
      'ticket.proposeStart': async (ticketId) => orchestrator.proposeStartFromDrag(await repos.tickets.get(ticketId)),
      'ticket.proposeReplace': async (ticketId) => orchestrator.proposeReplaceFromButton(await repos.tickets.get(ticketId)),
      // Reached only through `invoke` (the renderer's IPC): only the user decides a proposal. No runtime needed.
      'proposal.confirm': (id, override) => proposals.confirm(id, override),
      'proposal.reject': (id) => proposals.reject(id)
    }

    const intake = createIntakeHandler({
      workspaces: () => repos.workspaces.list(),
      ticketFolders: (ws) => ticketFoldersFor(cfg.paths, ws.slug),
      createTicket: (ws, input) => createTicket(ws, { ...input, blockedBy: undefined }),
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
            for (const m of modes.values()) m.dispose()
            gate.dispose()
            holds.dispose()
            stuckDetector.dispose()
            freshness.dispose()
            wakeScheduler.dispose()
            await Promise.all([runner.shutdown(), orchestrator.shutdown()])
            // Recovery stops at its next step once the runner is shutting down; wait for it, but not for long.
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, RECOVERY_WAIT_MS)
              void recovery.finally(() => {
                clearTimeout(timer)
                resolve()
              })
            })
          } finally {
            // A measurement under way reads the database.
            await freshness.idle()
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
