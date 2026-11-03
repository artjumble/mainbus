import { create } from 'zustand'
import type { BoardTicket, WorkspaceSummary } from '../../shared/api'
import type { ClaudeSetup, Ticket, UnattendedState, UsageState, Workspace } from '../../shared/domain'
import { invoke, onEngineEvent } from './api'
import { errorMessage } from './notify'

export type { BoardTicket }

/** The columns a person can place a card in by hand; the rest follow the agent's work. */
export type ManualColumn = Ticket['manualColumn']

interface MainbusState {
  /** null until the first setup check answers. */
  setup: ClaudeSetup | null
  workspace: Workspace | null
  /** False until the first workspace lookup answers, so the screen doesn't flash "open a folder". */
  workspaceLoaded: boolean
  /** Every open workspace with its rail counts, oldest first; empty until the first read. */
  workspaces: WorkspaceSummary[]
  /** The workspace settings drawer (it shows the focused workspace). */
  settingsOpen: boolean
  tickets: BoardTicket[]
  /** Why the first load failed, shown with a Try again button; null otherwise. */
  loadError: string | null
  /** Set by clicking a card; the ticket view (Task 14) reads it. */
  currentTicketId: string | null
  /** Unattended mode, as the engine last reported it. */
  unattended: UnattendedState
  /** Where the app stands on the usage limit, as the engine last reported it. */
  usage: UsageState
  /**
   * Moves the person asked for that the engine has not finished, by ticket id. The board shows these cards in
   * their target column at once; `tickets` keeps the engine's view, so refreshes meanwhile don't undo the move.
   */
  pendingMoves: Record<string, ManualColumn>
  /**
   * A proposal the panel should show: it expands if collapsed and scrolls to the card. `n` counts reveals, so
   * revealing the same proposal again shows it again.
   */
  revealedProposal: { id: string; n: number } | null

  /** The first load: setup check, then workspace and board. Never rejects; a failure lands in `loadError`. */
  load(): Promise<void>
  checkSetup(): Promise<void>
  openWorkspace(repoPath: string): Promise<void>
  /** Reads the rail's summaries. Runs one at a time: a call made meanwhile waits and reads once more afterwards. */
  refreshWorkspaces(): Promise<void>
  /** Makes the workspace the focused one; the board shows it and an open ticket view closes. */
  focusWorkspace(id: string): Promise<void>
  /** Removes the workspace from Mainbus (never its repo); rejects with the engine's refusal. Returns the ticket folders it kept. */
  removeWorkspace(id: string): Promise<{ keptFolders: string[] }>
  openSettings(): void
  closeSettings(): void
  /** Reads the board. Runs one at a time: a call made meanwhile waits and reads once more afterwards. */
  refreshBoard(): Promise<void>
  /** Re-reads the focused workspace, its board and its unattended state, after focus moved or a workspace opened or was removed. */
  reloadFocused(): Promise<void>
  openTicket(id: string): void
  closeTicket(): void
  /**
   * Asks the engine to move a ticket, showing it in the target column until the engine answers. On 'moved'
   * the board is read again before the overlay goes, so the card does not flicker back. Rejects with the
   * engine's reason when it refuses; on 'dirty' or a rejection the card returns to its real column.
   */
  moveTicket(id: string, to: ManualColumn): Promise<'moved' | 'dirty'>
  /** Switches unattended mode; rejects with the engine's reason when it can't be switched on. */
  setUnattended(on: boolean): Promise<void>
  /** Asks the engine for a start proposal for a Backlog or Ready ticket (the card dragged into In progress), then shows it. */
  proposeStart(ticketId: string): Promise<void>
  /** Asks the engine for a replace proposal for the ticket's active role (the Replace… button), then shows its card. */
  proposeReplace(ticketId: string): Promise<void>
  revealProposal(id: string): void
}

const UNATTENDED_OFF: UnattendedState = { on: false, status: { kind: 'off' } }

/** Plain-data equality (tickets are JSON from the engine). */
function isEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => isEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/**
 * Every board read delivers brand-new objects. Keeps the previous object for each ticket that did not change,
 * and the previous array when nothing changed, so unchanged cards do not re-render.
 */
function stabilize(previous: BoardTicket[], next: BoardTicket[]): BoardTicket[] {
  const byId = new Map(previous.map((t) => [t.id, t]))
  const merged = next.map((t) => {
    const old = byId.get(t.id)
    return old && isEqual(old, t) ? old : t
  })
  return merged.length === previous.length && merged.every((t, i) => t === previous[i]) ? previous : merged
}

/** Board refreshes triggered by engine events are at most this far apart. */
const BOARD_REFRESH_WINDOW_MS = 150

/**
 * Wraps a read so at most one is in flight. Asking again meanwhile shares a single trailing read (the engine
 * announces board.changed for every thread event, and reads must not pile up).
 */
function oneAtATime(read: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null
  let trailing: Promise<void> | null = null
  const next = (): Promise<void> => {
    if (!running) {
      const mine = read().finally(() => {
        running = null
      })
      running = mine
      return mine
    }
    trailing ??= running
      .catch(() => {})
      .then(() => {
        trailing = null
        return next()
      })
    return trailing
  }
  return next
}

export const useMainbus = create<MainbusState>()((set, get) => ({
  setup: null,
  workspace: null,
  workspaceLoaded: false,
  workspaces: [],
  settingsOpen: false,
  tickets: [],
  loadError: null,
  currentTicketId: null,
  unattended: UNATTENDED_OFF,
  usage: { kind: 'ok' },
  pendingMoves: {},
  revealedProposal: null,

  async load() {
    set({ loadError: null })
    try {
      await get().checkSetup()
    } catch (err) {
      set({ loadError: errorMessage(err) })
    }
  },

  async checkSetup() {
    const setup = await invoke('setup.check')
    set({ setup })
    if (!setup.ok) return
    const workspace = await invoke('workspace.get')
    set({ workspace, workspaceLoaded: true })
    // The rail's counts come from stored state, so they show at once.
    await get().refreshWorkspaces()
    if (workspace) await get().refreshBoard()
    set({ unattended: await invoke('unattended.get'), usage: await invoke('usage.get') })
  },

  async openWorkspace(repoPath) {
    const workspace = await invoke('workspace.open', repoPath)
    set({ workspace, workspaceLoaded: true })
    await Promise.all([get().refreshBoard(), get().refreshWorkspaces()])
  },

  refreshWorkspaces: oneAtATime(async () => {
    const workspaces = await invoke('workspace.summaries')
    if (!isEqual(workspaces, get().workspaces)) set({ workspaces })
  }),

  async focusWorkspace(id) {
    await invoke('workspace.focus', id)
    await get().reloadFocused()
  },

  async removeWorkspace(id) {
    const result = await invoke('workspace.remove', id)
    await get().reloadFocused()
    await get().refreshWorkspaces()
    return result
  },

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  async reloadFocused() {
    const workspace = await invoke('workspace.get')
    const changed = workspace?.id !== get().workspace?.id
    set({ workspace, workspaceLoaded: true, ...(changed ? { currentTicketId: null, tickets: [] } : {}) })
    if (!workspace) return
    await get().refreshBoard()
    set({ unattended: await invoke('unattended.get') })
  },

  refreshBoard: oneAtATime(async () => {
    const { tickets } = await invoke('board.get')
    const stable = stabilize(get().tickets, tickets)
    if (stable !== get().tickets) set({ tickets: stable })
  }),

  openTicket: (id) => set({ currentTicketId: id }),
  closeTicket: () => set({ currentTicketId: null }),

  async moveTicket(id, to) {
    set((s) => ({ pendingMoves: { ...s.pendingMoves, [id]: to } }))
    try {
      const result = await invoke('ticket.move', id, to)
      if (result === 'moved') await get().refreshBoard()
      return result
    } finally {
      set((s) => {
        const { [id]: _settled, ...rest } = s.pendingMoves
        return { pendingMoves: rest }
      })
    }
  },

  async proposeStart(ticketId) {
    const proposal = await invoke('ticket.proposeStart', ticketId)
    get().revealProposal(proposal.id)
  },

  async proposeReplace(ticketId) {
    const proposal = await invoke('ticket.proposeReplace', ticketId)
    get().revealProposal(proposal.id)
  },

  revealProposal: (id) => set((s) => ({ revealedProposal: { id, n: (s.revealedProposal?.n ?? 0) + 1 } })),

  async setUnattended(on) {
    // Every change arrives as an `unattended.changed` event, in order with the ones after it; the reply
    // could overtake those, so it is not used.
    await invoke('unattended.set', on)
  }
}))

/**
 * Loads the initial state and keeps the board fresh: `board.changed` refreshes it, at most once per 150 ms.
 * A failing initial load is kept in `loadError`. A failing refresh goes to `onError`, once, until a refresh
 * works again. Returns the unsubscribe function.
 */
export function startSync(onError: (err: unknown) => void): () => void {
  const board = throttled(() => useMainbus.getState().refreshBoard(), onError)
  const rail = throttled(() => useMainbus.getState().refreshWorkspaces(), onError)

  const off = onEngineEvent((e) => {
    if (e.type === 'unattended.changed') {
      // The board shows the focused workspace; another workspace's mode is not its business.
      if (e.workspaceId === useMainbus.getState().workspace?.id) useMainbus.setState({ unattended: e.state })
      return
    }
    if (e.type === 'workspaces.changed') {
      void useMainbus.getState().reloadFocused().catch(onError)
      return
    }
    if (e.type === 'usage.changed') {
      useMainbus.setState({ usage: e.state })
      return
    }
    // The rail counts every workspace.
    if (e.type === 'decision.changed') rail.request()
    if (e.type !== 'board.changed') return
    rail.request()
    // Only the focused workspace's board is on screen.
    if (e.workspaceId !== useMainbus.getState().workspace?.id) return
    board.request()
  })
  void useMainbus.getState().load()
  return () => {
    off()
    board.cancel()
    rail.cancel()
  }
}

/**
 * Runs `refresh` for requests at most once per window: a burst (every thread event announces a change) costs one
 * refresh per window: the first runs at once, the rest wait for one trailing refresh. A failing refresh goes to
 * `onError`, once, until a refresh works again.
 */
function throttled(
  refresh: () => Promise<void>,
  onError: (err: unknown) => void
): { request(): void; cancel(): void } {
  let reported = false
  let lastRefresh = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  function run(): void {
    lastRefresh = Date.now()
    refresh().then(
      () => {
        reported = false
      },
      (err: unknown) => {
        if (reported) return
        reported = true
        onError(err)
      }
    )
  }

  return {
    request() {
      if (timer) return
      const wait = lastRefresh + BOARD_REFRESH_WINDOW_MS - Date.now()
      if (wait <= 0) {
        run()
        return
      }
      timer = setTimeout(() => {
        timer = null
        run()
      }, wait)
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}
