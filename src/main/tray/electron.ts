import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, Menu, nativeImage, nativeTheme, Notification, shell, Tray, type NativeImage } from 'electron'
import { NAVIGATE_CHANNEL, type AppNavigation } from '../../shared/api'
import { trayIconFile, type TrayShade } from '../appIcon'
import type { MenuEntry, Notifier, Prefs, TrayView, WindowPort } from './controller'
import { badgeIcon, trayIconSet, type Bitmap } from './icons'
import { shortcutNeedsWrite, type ShortcutDetails } from './shortcut'
import type { Timer } from './toasts'

/** An image with a 16 px and a 32 px (200% scale) version, so it is sharp at any display scale. */
function image(make: (size: number) => Bitmap): NativeImage {
  const small = make(16)
  const img = nativeImage.createFromBitmap(small.buffer, { width: small.width, height: small.height })
  const big = make(32)
  img.addRepresentation({ scaleFactor: 2, width: big.width, height: big.height, buffer: big.buffer })
  return img
}

export const realTimer: Timer = (fn, ms) => {
  const id = setTimeout(fn, ms)
  return () => clearTimeout(id)
}

/** The tray icon from the glyph's PNGs in `dir`, at every display scale, with or without the needs-you dot. */
function trayImage(dir: string, shade: TrayShade, dot: boolean): NativeImage {
  const load = (size: number): Bitmap => {
    const png = nativeImage.createFromPath(trayIconFile(dir, shade, size))
    if (png.isEmpty()) throw new Error(`Mainbus has no tray icon at ${trayIconFile(dir, shade, size)}`)
    const { width, height } = png.getSize()
    return { width, height, buffer: png.toBitmap() }
  }
  const img = nativeImage.createEmpty()
  for (const { scaleFactor, bitmap } of trayIconSet(load, dot)) {
    img.addRepresentation({ scaleFactor, width: bitmap.width, height: bitmap.height, buffer: bitmap.buffer })
  }
  return img
}

/**
 * The real tray icon, from the app's icons in `dir`: the white glyph on a dark taskbar, the black one on a light one,
 * following Windows' taskbar setting as it changes.
 */
export function electronTrayView(dir: string): TrayView {
  const shade = (): TrayShade => (nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? 'white' : 'black')
  const images = new Map<string, NativeImage>()
  const imageFor = (dot: boolean): NativeImage => {
    const key = `${shade()}:${dot}`
    let img = images.get(key)
    if (!img) {
      img = trayImage(dir, shade(), dot)
      images.set(key, img)
    }
    return img
  }
  let dotShown = false
  const tray = new Tray(imageFor(false))
  tray.setToolTip('Mainbus')
  const repaint = (): void => {
    if (!tray.isDestroyed()) tray.setImage(imageFor(dotShown))
  }
  nativeTheme.on('updated', repaint)
  return {
    setDot: (dot) => {
      dotShown = dot
      repaint()
    },
    setToolTip: (text) => tray.setToolTip(text),
    setMenu: (items: MenuEntry[]) =>
      tray.setContextMenu(
        Menu.buildFromTemplate(
          items.map((item) => (item ? { label: item.label, enabled: item.enabled, click: item.action } : { type: 'separator' as const }))
        )
      ),
    onClick: (cb) => {
      tray.on('click', cb)
    },
    destroy: () => {
      nativeTheme.removeListener('updated', repaint)
      tray.destroy()
    }
  }
}

/** The main window as the tray controller drives it. `create` opens a new one if the old is gone. */
export function electronWindowPort(getWindow: () => BrowserWindow | null, create: () => BrowserWindow): WindowPort {
  const live = (): BrowserWindow | null => {
    const win = getWindow()
    return win && !win.isDestroyed() ? win : null
  }
  const badges = new Map<string, NativeImage>()
  return {
    isVisible: () => live()?.isVisible() ?? false,
    isFocused: () => live()?.isFocused() ?? false,
    show: () => {
      const win = live() ?? create()
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    },
    hide: () => live()?.hide(),
    setBadge: (text, description) => {
      const win = live()
      if (!win) return
      if (text === null) {
        win.setOverlayIcon(null, '')
        return
      }
      let img = badges.get(text)
      if (!img) {
        img = image((s) => badgeIcon(text, s))
        badges.set(text, img)
      }
      win.setOverlayIcon(img, description)
    },
    navigate: (nav: AppNavigation) => live()?.webContents.send(NAVIGATE_CHANNEL, nav)
  }
}

/**
 * Windows toasts, showing the app icon at `icon` (a file path, as Windows needs). Each notification is kept until it is
 * clicked or closed: its click handler is collected otherwise.
 */
export function electronNotifier(icon: string): Notifier {
  const shown = new Set<Notification>()
  return {
    show: ({ title, body, onClick }) => {
      if (!Notification.isSupported()) return
      const note = new Notification({ title, body, icon })
      shown.add(note)
      note.on('click', () => {
        shown.delete(note)
        onClick()
      })
      note.on('close', () => shown.delete(note))
      note.on('failed', () => shown.delete(note))
      note.show()
    }
  }
}

/** Whether the "still running" notice was shown already: a small file, since this is the main process's own state. */
export function filePrefs(file: string): Prefs {
  const read = (): boolean => {
    try {
      return (JSON.parse(fs.readFileSync(file, 'utf8')) as { noticeShown?: unknown }).noticeShown === true
    } catch {
      return false
    }
  }
  return {
    noticeShown: read,
    markNoticeShown: () => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, JSON.stringify({ noticeShown: true }))
      } catch (err) {
        console.error('Mainbus could not remember that the tray notice was shown:', err)
      }
    }
  }
}

export const APP_USER_MODEL_ID = 'app.mainbus'

/**
 * Windows shows notifications only for an app with a Start Menu shortcut that carries its app ID. Keeps a "Mainbus"
 * shortcut pointing at the running build, written only when missing or out of date. A failure is logged, never fatal.
 * Callers run this only for the packaged app, never in development or tests.
 */
export function ensureStartMenuShortcut(): void {
  if (process.platform !== 'win32') return
  app.setAppUserModelId(APP_USER_MODEL_ID)
  const link = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Mainbus.lnk')
  const wanted: ShortcutDetails = { target: process.execPath, appUserModelId: APP_USER_MODEL_ID }
  try {
    let existing: ShortcutDetails | null = null
    if (fs.existsSync(link)) {
      try {
        const details = shell.readShortcutLink(link)
        existing = { target: details.target, appUserModelId: details.appUserModelId ?? '' }
      } catch {
        existing = null
      }
    }
    if (!shortcutNeedsWrite(existing, wanted)) return
    shell.writeShortcutLink(link, fs.existsSync(link) ? 'replace' : 'create', {
      target: wanted.target,
      appUserModelId: wanted.appUserModelId,
      description: 'Mainbus'
    })
  } catch (err) {
    console.error('Mainbus could not update its Start Menu shortcut:', err)
  }
}
