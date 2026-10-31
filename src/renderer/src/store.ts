import { create } from 'zustand'
import type { ClaudeSetup, Ticket, TicketState, Workspace } from '../../shared/domain'
import { invoke, onEngineEvent } from './api'
import { errorMessage } from './notify'

export type BoardTicket = Ticket & { state: TicketState }

interface MainbusState {
  /** null until the first setup check answers. */
  setup: ClaudeSetup | null
  workspace: Workspace | null
  /** False until the first workspace lookup answers, so the screen doesn't flash "open a folder". */
  workspaceLoaded: boolean
  tickets: BoardTicket[]
  /** Why the first load failed, shown with a Try again button; null otherwise. */
  loadError: string | null
  /** Set by clicking a card; the ticket view (Task 14) reads it. */
  currentTicketId: string | null

  /** The first load: setup check, then workspace and board. Never rejects; a failure lands in `loadError`. */
  load(): Promise<void>
  checkSetup(): Promise<void>
  openWorkspace(repoPath: string): Promise<void>
  /** Reads the board. Runs one at a time: a call made meanwhile waits and reads once more afterwards. */
  refreshBoard(): Promise<void>
  openTicket(id: string): void
  closeTicket(): void
}

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

// At most one board read is in flight. Asking again meanwhile shares a single trailing read (the engine
// announces board.changed for every thread event, and reads must not pile up).
let running: Promise<void> | null = null
let trailing: Promise<void> | null = null

export const useMainbus = create<MainbusState>()((set, get) => ({
  setup: null,
  workspace: null,
  workspaceLoaded: false,
  tickets: [],
  loadError: null,
  currentTicketId: null,

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
    if (workspace) await get().refreshBoard()
  },

  async openWorkspace(repoPath) {
    const workspace = await invoke('workspace.open', repoPath)
    set({ workspace, workspaceLoaded: true })
    await get().refreshBoard()
  },

  refreshBoard() {
    const read = async (): Promise<void> => {
      const { tickets } = await invoke('board.get')
      const stable = stabilize(get().tickets, tickets)
      if (stable !== get().tickets) set({ tickets: stable })
    }
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
        return get().refreshBoard()
      })
    return trailing
  },

  openTicket: (id) => set({ currentTicketId: id }),
  closeTicket: () => set({ currentTicketId: null })
}))

/**
 * Loads the initial state and keeps the board fresh: `board.changed` refreshes it, at most once per 150 ms.
 * A failing initial load is kept in `loadError`. A failing refresh goes to `onError`, once, until a refresh
 * works again. Returns the unsubscribe function.
 */
export function startSync(onError: (err: unknown) => void): () => void {
  let reported = false
  let lastRefresh = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  function refresh(): void {
    lastRefresh = Date.now()
    useMainbus
      .getState()
      .refreshBoard()
      .then(
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

  const off = onEngineEvent((e) => {
    if (e.type !== 'board.changed') return
    // A burst (every thread event announces a change) costs one refresh per window: the first runs at once,
    // the rest wait for one trailing refresh.
    if (timer) return
    const wait = lastRefresh + BOARD_REFRESH_WINDOW_MS - Date.now()
    if (wait <= 0) {
      refresh()
      return
    }
    timer = setTimeout(() => {
      timer = null
      refresh()
    }, wait)
  })
  void useMainbus.getState().load()
  return () => {
    off()
    if (timer) clearTimeout(timer)
    timer = null
  }
}
