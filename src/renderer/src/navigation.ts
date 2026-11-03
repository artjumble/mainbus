import type { AppNavigation } from '../../shared/api'
import { invoke, onNavigate } from './api'
import { showError } from './notify'
import { useMainbus } from './store'

/** Shows what the main process asked for: a ticket, or the board's Needs you column, in the right workspace. */
export async function navigateTo(nav: AppNavigation): Promise<void> {
  const store = useMainbus.getState()
  if (nav.workspaceId && nav.workspaceId !== store.workspace?.id) {
    await invoke('workspace.focus', nav.workspaceId)
    // Reloading clears the open ticket when the workspace changes, so the ticket opens only after it.
    await useMainbus.getState().reloadFocused()
  }
  if (nav.to === 'ticket') {
    useMainbus.getState().openTicket(nav.ticketId)
    return
  }
  useMainbus.getState().closeTicket()
  // The board shows on the next render; then the column is brought into view.
  requestAnimationFrame(() => {
    document.getElementById('column-needs_you')?.scrollIntoView?.({ block: 'nearest', inline: 'center' })
  })
}

/** Follows the main process's requests (toast and tray clicks); returns the unsubscribe function. */
export function startNavigation(): () => void {
  return onNavigate((nav) => {
    navigateTo(nav).catch((err: unknown) => showError(err, 'Could not open that'))
  })
}
