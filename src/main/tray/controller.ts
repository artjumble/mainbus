import type { AppNavigation, BoardTicket, CommandArgs, CommandName, CommandResult, EngineEvent } from '../../shared/api'
import type { Workspace } from '../../shared/domain'
import { arrivals, countActivity, snapshotOf, type Activity, type Arrival, type ColumnSnapshot } from './activity'
import { closeAction } from './closePolicy'
import { badgeDescription, badgeText, needsYouLabel, STILL_RUNNING, toastText, tooltipText, type ToastText } from './text'
import { ToastBatcher, type Timer } from './toasts'

export interface MenuItem {
  label: string
  enabled: boolean
  action: () => void
}
/** A separator is `null`. */
export type MenuEntry = MenuItem | null

/** The tray icon, as far as the controller needs it. */
export interface TrayView {
  setDot(dot: boolean): void
  setToolTip(text: string): void
  setMenu(items: MenuEntry[]): void
  onClick(cb: () => void): void
  destroy(): void
}

export interface WindowPort {
  isVisible(): boolean
  isFocused(): boolean
  /** Restores, shows and focuses the window; opens a new one if it was destroyed. */
  show(): void
  hide(): void
  /** The overlay on the taskbar button; null clears it. */
  setBadge(text: string | null, description: string): void
  navigate(nav: AppNavigation): void
}

export interface Notifier {
  show(n: ToastText & { onClick: () => void }): void
}

export interface Prefs {
  noticeShown(): boolean
  markNoticeShown(): void
}

export interface EngineSource {
  invoke<K extends CommandName>(command: K, ...args: CommandArgs<K>): Promise<CommandResult<K>> | CommandResult<K>
  on(listener: (e: EngineEvent) => void): () => void
}

export interface TrayDeps {
  source: EngineSource
  view: TrayView
  window: WindowPort
  notifier: Notifier
  prefs: Prefs
  quit: () => void
  timer: Timer
  /** How often the counts are read at most. */
  refreshMs?: number
  onError?: (err: unknown) => void
}

const REFRESH_MS = 250

/**
 * Keeps the tray icon, its menu, the taskbar badge and the toasts in step with the boards of every workspace, and
 * decides what closing the window does. Everything outside this class is behind the small interfaces above.
 */
export class TrayController {
  private activity: Activity = { working: 0, needsYou: 0, openAgents: 0 }
  private snapshots = new Map<string, ColumnSnapshot>()
  private workspaces: Workspace[] = []
  private needsYouByWorkspace = new Map<string, number>()
  private reading: Promise<void> | null = null
  private again = false
  private scheduled = false
  private off: (() => void) | null = null
  private disposed = false
  private readonly batcher: ToastBatcher

  constructor(private readonly d: TrayDeps) {
    this.batcher = new ToastBatcher({
      timer: d.timer,
      // Hidden or unfocused: a window the user is looking at needs no toast.
      hidden: () => !d.window.isVisible() || !d.window.isFocused(),
      flush: (batch) => this.announce(batch)
    })
  }

  /** Reads the boards once (seeding, so nothing is announced) and follows the engine's events from then on. */
  async start(): Promise<void> {
    this.d.view.onClick(() => this.d.window.show())
    this.off = this.d.source.on((e) => {
      if (e.type === 'board.changed' || e.type === 'decision.changed' || e.type === 'workspaces.changed') this.schedule()
    })
    this.render()
    await this.refresh()
  }

  dispose(): void {
    this.disposed = true
    this.off?.()
    this.batcher.dispose()
    this.d.view.destroy()
  }

  private schedule(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    this.d.timer(() => {
      this.scheduled = false
      void this.refresh()
    }, this.d.refreshMs ?? REFRESH_MS)
  }

  /** Reads every workspace's board now: one read at a time, with one more after it if events came in meanwhile. */
  refresh(): Promise<void> {
    if (this.reading) {
      this.again = true
      return this.reading
    }
    this.reading = this.read()
      .catch((err: unknown) => this.d.onError?.(err))
      .finally(() => {
        this.reading = null
        if (this.again) {
          this.again = false
          this.schedule()
        }
      })
    return this.reading
  }

  private async read(): Promise<void> {
    const workspaces = await this.d.source.invoke('workspace.list')
    const boards = await this.boardsOf(workspaces)
    if (this.disposed) return
    const found: Arrival[] = []
    const next = new Map<string, ColumnSnapshot>()
    workspaces.forEach((ws, i) => {
      const tickets = boards[i]!
      found.push(...arrivals(this.snapshots.get(ws.id) ?? null, tickets))
      next.set(ws.id, snapshotOf(tickets))
      this.needsYouByWorkspace.set(ws.id, tickets.filter((t) => t.state.column === 'needs_you').length)
    })
    this.snapshots = next
    this.workspaces = workspaces
    this.activity = countActivity(boards)
    this.render()
    this.batcher.add(found)
  }

  private boardsOf(workspaces: Workspace[]): Promise<BoardTicket[][]> {
    return Promise.all(workspaces.map(async (ws) => (await this.d.source.invoke('board.get', ws.id)).tickets))
  }

  private render(): void {
    const { working, needsYou } = this.activity
    this.d.view.setDot(needsYou > 0)
    this.d.view.setToolTip(tooltipText(working, needsYou))
    this.d.window.setBadge(badgeText(needsYou), badgeDescription(needsYou))
    this.d.view.setMenu([
      { label: 'Open Mainbus', enabled: true, action: () => this.d.window.show() },
      { label: needsYouLabel(needsYou), enabled: needsYou > 0, action: () => this.openNeedsYou(null) },
      null,
      { label: 'Quit', enabled: true, action: () => this.d.quit() }
    ])
  }

  /** Shows the Needs you column of the preferred workspace if it has any such ticket, else of the first that does. */
  private openNeedsYou(preferred: string | null): void {
    const has = (id: string): boolean => (this.needsYouByWorkspace.get(id) ?? 0) > 0
    const target = preferred && has(preferred) ? preferred : (this.workspaces.find((w) => has(w.id))?.id ?? preferred)
    this.d.window.show()
    this.d.window.navigate({ to: 'needsYou', workspaceId: target })
  }

  private announce(batch: Arrival[]): void {
    const names = this.workspaces.length > 1 ? new Map(this.workspaces.map((w) => [w.id, w.name])) : null
    const text: ToastText = toastText(batch, names)
    const only = batch.length === 1 ? batch[0]! : null
    this.d.notifier.show({
      ...text,
      onClick: () => {
        if (only) {
          this.d.window.show()
          this.d.window.navigate({ to: 'ticket', workspaceId: only.workspaceId, ticketId: only.ticketId })
        } else {
          this.openNeedsYou((batch.find((a) => a.column === 'needs_you') ?? batch[0]!).workspaceId)
        }
      }
    })
  }

  /** The window was asked to close: hide it while agents are open (and the setting allows), otherwise quit. */
  async handleClose(): Promise<void> {
    let action: 'hide' | 'quit' = 'quit'
    try {
      const workspaces = await this.d.source.invoke('workspace.list')
      const [{ whenClosed }, boards] = await Promise.all([this.d.source.invoke('settings.get'), this.boardsOf(workspaces)])
      action = closeAction({ whenClosed, openAgents: countActivity(boards).openAgents })
    } catch (err) {
      this.d.onError?.(err)
    }
    if (action === 'quit') {
      this.d.quit()
      return
    }
    this.d.window.hide()
    if (!this.d.prefs.noticeShown()) {
      this.d.prefs.markNoticeShown()
      this.d.notifier.show({ ...STILL_RUNNING, onClick: () => this.d.window.show() })
    }
  }
}
