/**
 * The ticket view's left column width, remembered on this machine. One width serves both
 * not-started and started tickets: it is simpler, and a column widened to edit a spec doesn't
 * jump when the run starts.
 */
export const MIN_CONTEXT_WIDTH = 380
export const DEFAULT_CONTEXT_WIDTH = 380
/** The room the conversation side keeps. */
export const MIN_CONVERSATION_WIDTH = 360
const KEY = 'mainbus.ticketContextWidth'

/** The widest the left column may be in a view of this width (the minimum wins when there is no room). */
export function maxContextWidth(viewWidth: number): number {
  return Math.max(MIN_CONTEXT_WIDTH, Math.floor(viewWidth - MIN_CONVERSATION_WIDTH))
}

export function clampContextWidth(width: number, viewWidth: number): number {
  return Math.min(Math.max(width, MIN_CONTEXT_WIDTH), maxContextWidth(viewWidth))
}

/** The remembered width, or the default when none is stored or storage can't be read. */
export function readContextWidth(): number {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null || raw.trim() === '') return DEFAULT_CONTEXT_WIDTH
    const width = Number(raw)
    if (!Number.isFinite(width)) return DEFAULT_CONTEXT_WIDTH
    return Math.max(width, MIN_CONTEXT_WIDTH)
  } catch {
    return DEFAULT_CONTEXT_WIDTH
  }
}

/** Remembers the width; storage that can't be written is ignored. */
export function writeContextWidth(width: number): void {
  try {
    localStorage.setItem(KEY, String(Math.round(width)))
  } catch {
    // Only a preference: the view still works.
  }
}
