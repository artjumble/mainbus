import type { WhenClosed } from '../../shared/domain'

/**
 * What closing the window does. On macOS the window is hidden whatever the agents are doing, unless the user chose to
 * always quit. Elsewhere, while agents are open and the user hasn't chosen to always quit, the app keeps running:
 * hidden to the tray, except on Linux where the tray may be invisible (stock GNOME has none), so the window is minimized
 * and stays in the taskbar. On Linux a close that arrives while the window is already minimized (Quit or Close from the
 * dock or taskbar) quits, so a user without a tray can still end the app.
 */
export function closeAction(o: {
  whenClosed: WhenClosed
  openAgents: number
  platform?: NodeJS.Platform
  minimized?: boolean
}): 'hide' | 'minimize' | 'quit' {
  // macOS convention: closing the window keeps the app running (in the Dock), unless the user chose to always quit.
  if (o.platform === 'darwin') return o.whenClosed === 'tray' ? 'hide' : 'quit'
  if (o.whenClosed !== 'tray' || o.openAgents <= 0) return 'quit'
  if (o.platform !== 'linux') return 'hide'
  return o.minimized ? 'quit' : 'minimize'
}
