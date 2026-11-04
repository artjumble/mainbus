import { GROUND, type ThemeChoice } from '../shared/domain'

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

/** The window's ground for a Theme choice: Match Windows ('system') takes Windows' own light or dark. */
export function windowBackground(choice: ThemeChoice, systemDark: boolean): string {
  const dark = choice === 'dark' || (choice === 'system' && systemDark)
  return dark ? GROUND.dark : GROUND.light
}

/**
 * Keeps the window frame, native menus and the window's own background in the scheme the Theme setting picks.
 * nativeTheme.themeSource takes the choice as it is, so the frame follows it and the page's prefers-color-scheme agrees;
 * with Match Windows, a change to the Windows setting while the app runs repaints the background too.
 */
export class WindowTheme {
  private choice: ThemeChoice = 'light'
  private readonly onUpdated = (): void => this.paint()

  constructor(
    private readonly native: NativeThemePort,
    private readonly window: () => ThemedWindow | null
  ) {
    native.on('updated', this.onUpdated)
  }

  apply(choice: ThemeChoice): void {
    this.choice = choice
    this.native.themeSource = choice
    this.paint()
  }

  /** The ground the window should show now; a new window is created with it, so there is no flash on launch. */
  background(): string {
    return windowBackground(this.choice, this.native.shouldUseDarkColors)
  }

  dispose(): void {
    this.native.removeListener('updated', this.onUpdated)
  }

  private paint(): void {
    const win = this.window()
    if (win && !win.isDestroyed()) win.setBackgroundColor(this.background())
  }
}
