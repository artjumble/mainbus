import type { MenuItemConstructorOptions } from 'electron'

/**
 * The application menu. Only macOS has one of its own: Windows and Linux keep Electron's default, so this returns null
 * there. On a Mac the Edit menu is essential, as without it ⌘C, ⌘V and ⌘A don't work in text fields. The View menu
 * (reload, DevTools) is only for an unpackaged app.
 */
export function appMenuTemplate(o: { platform: NodeJS.Platform; dev: boolean; openSettings: () => void }): MenuItemConstructorOptions[] | null {
  if (o.platform !== 'darwin') return null
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Mainbus',
      submenu: [
        { role: 'about', label: 'About Mainbus' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Command+,', click: () => o.openSettings() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Mainbus' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Mainbus' }
      ]
    },
    { role: 'editMenu' },
    {
      role: 'window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'close' }, { type: 'separator' }, { role: 'front' }]
    }
  ]
  if (o.dev) {
    template.splice(2, 0, {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }]
    })
  }
  return template
}
