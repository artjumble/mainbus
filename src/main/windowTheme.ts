import { GROUND, resolveTheme, THEME_SETTING_DEFAULT, themeOf, type ThemeSetting } from '../shared/domain'

/** What WindowTheme needs of Electron's nativeTheme. */
export interface NativeThemePort {
  themeSource: 'system' | 'light' | 'dark'
  readonly shouldUseDarkColors: boolean
  on(event: 'updated', listener: () => void): unknown
  removeListener(event: 'updated', listener: () => void): unknown
}

/** What WindowTheme needs of the window. */
export interface ThemedWindow {
  setBackgroundColor(color: string): void
  isDestroyed(): boolean
}

/** The window's ground for a Theme setting: Match Windows takes its light or dark theme, as Windows is. */
export function windowBackground(setting: ThemeSetting, systemDark: boolean): string {
  return GROUND[resolveTheme(setting, systemDark)]
}

/** The native theme source for a Theme setting: Windows' own with Match Windows, else the scheme of the theme. */
export function themeSourceOf(setting: ThemeSetting): NativeThemePort['themeSource'] {
  return setting.choice === 'system' ? 'system' : themeOf(setting.choice).scheme
}

/**
 * Keeps the window frame, native menus and the window's own background in the theme the Theme setting picks.
 * nativeTheme.themeSource takes the theme's scheme, so the frame follows it and the page's prefers-color-scheme agrees;
 * with Match Windows, a change to the Windows setting while the app runs repaints the background too.
 */
export class WindowTheme {
  private setting: ThemeSetting = THEME_SETTING_DEFAULT
  private readonly onUpdated = (): void => this.paint()

  constructor(
    private readonly native: NativeThemePort,
    private readonly window: () => ThemedWindow | null
  ) {
    native.on('updated', this.onUpdated)
  }

  apply(setting: ThemeSetting): void {
    this.setting = setting
    this.native.themeSource = themeSourceOf(setting)
    this.paint()
  }

  /** The ground the window should show now; a new window is created with it, so there is no flash on launch. */
  background(): string {
    return windowBackground(this.setting, this.native.shouldUseDarkColors)
  }

  dispose(): void {
    this.native.removeListener('updated', this.onUpdated)
  }

  private paint(): void {
    const win = this.window()
    if (win && !win.isDestroyed()) win.setBackgroundColor(this.background())
  }
}
