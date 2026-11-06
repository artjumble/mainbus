/** Whether the orchestrator panel is open or collapsed to its strip, remembered on this machine. */
const KEY = 'mainbus.orchestratorPanel'

/** True (open) unless it was last collapsed; storage that can't be read counts as open. */
export function readPanelOpen(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'collapsed'
  } catch {
    return true
  }
}

/** Remembers the panel's state; storage that can't be written is ignored. */
export function writePanelOpen(open: boolean): void {
  try {
    localStorage.setItem(KEY, open ? 'open' : 'collapsed')
  } catch {
    // Only a preference: the panel still works.
  }
}

export const MIN_PANEL_WIDTH = 280
export const MAX_PANEL_WIDTH = 720
export const DEFAULT_PANEL_WIDTH = 340
const WIDTH_KEY = 'mainbus.orchestratorPanelWidth'

/** The widest the panel may be in a window: half of it, at most 720, so the board keeps room (the minimum wins in tiny windows). */
export function maxPanelWidth(windowWidth: number): number {
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, Math.floor(windowWidth / 2)))
}

export function clampPanelWidth(width: number, windowWidth: number): number {
  return Math.min(Math.max(width, MIN_PANEL_WIDTH), maxPanelWidth(windowWidth))
}

/** The remembered width (280–720), or 340 when none is stored or storage can't be read. */
export function readPanelWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY)
    if (raw === null || raw.trim() === '') return DEFAULT_PANEL_WIDTH
    const width = Number(raw)
    if (!Number.isFinite(width)) return DEFAULT_PANEL_WIDTH
    return Math.min(Math.max(width, MIN_PANEL_WIDTH), MAX_PANEL_WIDTH)
  } catch {
    return DEFAULT_PANEL_WIDTH
  }
}

/** Remembers the panel's width; storage that can't be written is ignored. */
export function writePanelWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(width)))
  } catch {
    // Only a preference: the panel still works.
  }
}
