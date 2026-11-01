import { create } from 'zustand'
import type { BoardTicket } from '../../shared/api'
import type { ClaudeSetup, Ticket, UnattendedState, Workspace } from '../../shared/domain'
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
  tickets: BoardTicket[]
  /** Why the first load failed, shown with a Try again button; null otherwise. */
  loadError: string | null
  /** Set by clicking a card; the ticket view (Task 14) reads it. */
  currentTicketId: string | null
  /** Unattended mode, as the engine last reported it. */
  unattended: UnattendedState
  /**
   * Moves the person asked for that the engine has not finished, by ticket id. The board shows these cards in
   * their target column at once; `tickets` keeps the engine's view, so refreshes meanwhile don't undo the move.
   */
  pendingMoves: Record<string, ManualColumn>

  /** The first load: setup check, then workspace and board. Never rejects; a failure lands in `loadError`. */
  load(): Promise<void>
  checkSetup(): Promise<void>
  openWorkspace(repoPath: string): Promise<void>
  /** Reads the board. Runs one at a time: a call made meanwhile waits and reads once more afterwards. */
  refreshBoard(): Promise<void>
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
  unattended: UNATTENDED_OFF,
  pendingMoves: {},

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
    set({ unattended: await invoke('unattended.get') })
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
    if (e.type === 'unattended.changed') {
      useMainbus.setState({ unattended: e.state })
      return
    }
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
