import type { MenuEntry, Notifier, TrayView } from './controller'
import type { ToastText } from './text'

export interface RecordedToast extends ToastText {
  click(): void
}

/** What an end-to-end test sees of the tray, and the buttons it can press (`globalThis.__mainbusTray`). */
export interface TrayTestHook {
  tooltip(): string
  menu(): { label: string; enabled: boolean }[]
  trayClick(): void
  choose(label: string): void
  notifications(): ToastText[]
  clickNotification(index: number): void
}

/** Wraps the real tray icon to remember what was set on it, and to let a test press its menu and click it. */
export function recordTrayView(inner: TrayView): { view: TrayView; hook: Pick<TrayTestHook, 'tooltip' | 'menu' | 'trayClick' | 'choose'> } {
  let tooltip = ''
  let items: MenuEntry[] = []
  let click: () => void = () => {}
  const view: TrayView = {
    setDot: (dot) => inner.setDot(dot),
    setToolTip: (text) => {
      tooltip = text
      inner.setToolTip(text)
    },
    setMenu: (menu) => {
      items = menu
      inner.setMenu(menu)
    },
    onClick: (cb) => {
      click = cb
      inner.onClick(cb)
    },
    destroy: () => inner.destroy()
  }
  return {
    view,
    hook: {
      tooltip: () => tooltip,
      menu: () => items.flatMap((i) => (i ? [{ label: i.label, enabled: i.enabled }] : [])),
      trayClick: () => click(),
      choose: (label) => {
        const item = items.find((i) => i?.label === label)
        if (!item) throw new Error(`No tray menu item "${label}"`)
        item.action()
      }
    }
  }
}

/** A notifier that shows nothing on the desktop: it records the toasts, and a test clicks them. */
export function recordingNotifier(): { notifier: Notifier; hook: Pick<TrayTestHook, 'notifications' | 'clickNotification'> } {
  const shown: RecordedToast[] = []
  return {
    notifier: { show: ({ title, body, onClick }) => void shown.push({ title, body, click: onClick }) },
    hook: {
      notifications: () => shown.map(({ title, body }) => ({ title, body })),
      clickNotification: (index) => {
        const toast = shown[index]
        if (!toast) throw new Error(`No notification ${index}`)
        toast.click()
      }
    }
  }
}
