import type { WhenClosed } from '../../shared/domain'

/** What closing the window does: hide to the tray only while agents are open and the user hasn't chosen to always quit. */
export function closeAction(o: { whenClosed: WhenClosed; openAgents: number }): 'hide' | 'quit' {
  return o.whenClosed === 'tray' && o.openAgents > 0 ? 'hide' : 'quit'
}
