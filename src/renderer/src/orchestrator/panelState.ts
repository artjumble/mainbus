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
