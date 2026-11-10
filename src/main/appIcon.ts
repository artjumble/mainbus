import path from 'node:path'

/**
 * The tray icon's sizes in pixels: 16 at 100% display scale, then 125%, 150%, 200%, 250% and 300%. resources/icons
 * has a black and a white PNG at each, rendered from design/icons by `pnpm icons:build`.
 */
export const TRAY_SIZES = [16, 20, 24, 32, 40, 48] as const

/** The tray glyph's shade: black for a light taskbar, white for a dark one. */
export type TrayShade = 'black' | 'white'

/**
 * The folder of the icons the running app loads: resources/icons in the repo in development, copied to the packaged
 * app's resources/icons by electron-builder's extraResources (build/ is the packager's alone, and isn't shipped).
 */
export function iconDir(o: { packaged: boolean; resourcesPath: string; appPath: string }): string {
  return o.packaged ? path.join(o.resourcesPath, 'icons') : path.join(o.appPath, 'resources', 'icons')
}

/** The app icon for the windows, their taskbar buttons and the notifications. */
export function windowIconFile(dir: string): string {
  return path.join(dir, 'mainbus-256.png')
}

export function trayIconFile(dir: string, shade: TrayShade, size: number): string {
  return path.join(dir, `mainbus-tray-${shade}-${size}.png`)
}
