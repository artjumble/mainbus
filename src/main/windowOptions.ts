import type { BrowserWindowConstructorOptions } from 'electron'

/**
 * The main window's options. `icon` is the app icon (appIcon.ts), for the window and its taskbar button: without it,
 * `pnpm dev` shows Electron's own icon. `background`, when known, is the ground of the chosen scheme, so a dark window
 * shows no white before the page has painted.
 */
export function mainWindowOptions(o: {
  preload: string
  icon: string
  background: string | null
  /** End-to-end tests only: the content size, which may be larger than the screen (macOS), so a runner's screen doesn't matter. */
  testSize?: { width: number; height: number } | null
}): BrowserWindowConstructorOptions {
  return {
    width: o.testSize?.width ?? 1280,
    height: o.testSize?.height ?? 800,
    ...(o.testSize ? { useContentSize: true, enableLargerThanScreen: true } : {}),
    title: 'Mainbus',
    icon: o.icon,
    autoHideMenuBar: true,
    ...(o.background ? { backgroundColor: o.background } : {}),
    webPreferences: {
      preload: o.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  }
}
