import { describe, expect, it } from 'vitest'
import { GROUND, THEME_SETTING_DEFAULT, type ThemeChoice, type ThemeSetting } from '../shared/domain'
import { themeSourceOf, WindowTheme, windowBackground, type NativeThemePort, type ThemedWindow } from './windowTheme'

/** Electron's nativeTheme as far as WindowTheme sees it: Windows' own setting, and the source the app sets. */
class FakeNativeTheme implements NativeThemePort {
  windowsDark = false
  private source: NativeThemePort['themeSource'] = 'system'
  private listeners = new Set<() => void>()

  get themeSource(): NativeThemePort['themeSource'] {
    return this.source
  }
  set themeSource(v: NativeThemePort['themeSource']) {
    this.source = v
    this.emit()
  }
  get shouldUseDarkColors(): boolean {
    return this.source === 'dark' || (this.source === 'system' && this.windowsDark)
  }
  on(_: 'updated', l: () => void): void {
    this.listeners.add(l)
  }
  removeListener(_: 'updated', l: () => void): void {
    this.listeners.delete(l)
  }
  /** The user changes the Windows setting. */
  setWindowsDark(dark: boolean): void {
    this.windowsDark = dark
    this.emit()
  }
  private emit(): void {
    for (const l of this.listeners) l()
  }
}

class FakeWindow implements ThemedWindow {
  background: string | null = null
  destroyed = false
  setBackgroundColor(c: string): void {
    this.background = c
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
}

/** The Theme setting with this choice, and Match Windows between Light and Dark. */
const choose = (choice: ThemeChoice, picks: Partial<ThemeSetting> = {}): ThemeSetting => ({ ...THEME_SETTING_DEFAULT, ...picks, choice })

describe('windowBackground', () => {
  it.each([
    ['light', false, GROUND.light],
    ['light', true, GROUND.light],
    ['dark', false, GROUND.dark],
    ['dark', true, GROUND.dark],
    ['night-owl', false, GROUND['night-owl']],
    ['night-owl', true, GROUND['night-owl']],
    ['light-owl', false, GROUND['light-owl']],
    ['light-owl', true, GROUND['light-owl']],
    ['system', false, GROUND.light],
    ['system', true, GROUND.dark]
  ] as const)('%s with Windows dark %s paints %s', (choice, systemDark, expected) => {
    expect(windowBackground(choose(choice), systemDark)).toBe(expected)
  })

  it('with Match Windows, paints the light or dark theme it picks', () => {
    const owls = { light: 'light-owl', dark: 'night-owl' } as const
    expect(windowBackground(choose('system', owls), false)).toBe('#F0F0F0')
    expect(windowBackground(choose('system', owls), true)).toBe('#011627')
  })
})

describe('themeSourceOf', () => {
  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
    ['night-owl', 'dark'],
    ['light-owl', 'light'],
    ['system', 'system']
  ] as const)('%s sets the frame and menus to %s', (choice, source) => {
    expect(themeSourceOf(choose(choice))).toBe(source)
  })
})

describe('WindowTheme', () => {
  it("sets the native theme source to the theme's scheme, so the frame and menus agree, and paints the window", () => {
    const native = new FakeNativeTheme()
    native.windowsDark = true
    const win = new FakeWindow()
    const theme = new WindowTheme(native, () => win)

    theme.apply(choose('light'))
    expect(native.themeSource).toBe('light')
    expect(win.background).toBe(GROUND.light)
    expect(theme.background()).toBe(GROUND.light)

    theme.apply(choose('dark'))
    expect(native.themeSource).toBe('dark')
    expect(win.background).toBe(GROUND.dark)

    theme.apply(choose('night-owl'))
    expect(native.themeSource).toBe('dark')
    expect(win.background).toBe(GROUND['night-owl'])

    theme.apply(choose('light-owl'))
    expect(native.themeSource).toBe('light')
    expect(win.background).toBe(GROUND['light-owl'])

    theme.apply(choose('system'))
    expect(native.themeSource).toBe('system')
    expect(win.background).toBe(GROUND.dark)
  })

  it('gives a new window the ground of the choice before it has loaded anything', () => {
    const native = new FakeNativeTheme()
    const theme = new WindowTheme(native, () => null)
    theme.apply(choose('dark'))
    expect(theme.background()).toBe(GROUND.dark)
    theme.apply(choose('night-owl'))
    expect(theme.background()).toBe(GROUND['night-owl'])
  })

  it('with Match Windows, follows the Windows setting while the app runs', () => {
    const native = new FakeNativeTheme()
    const win = new FakeWindow()
    const theme = new WindowTheme(native, () => win)
    theme.apply(choose('system'))
    expect(win.background).toBe(GROUND.light)

    native.setWindowsDark(true)
    expect(win.background).toBe(GROUND.dark)
    expect(theme.background()).toBe(GROUND.dark)

    native.setWindowsDark(false)
    expect(win.background).toBe(GROUND.light)
  })

  it('with Match Windows set to Light Owl and Night Owl, switches between them as Windows changes', () => {
    const native = new FakeNativeTheme()
    const win = new FakeWindow()
    const theme = new WindowTheme(native, () => win)
    theme.apply(choose('system', { light: 'light-owl', dark: 'night-owl' }))
    expect(native.themeSource).toBe('system')
    expect(win.background).toBe(GROUND['light-owl'])
    native.setWindowsDark(true)
    expect(win.background).toBe(GROUND['night-owl'])
    native.setWindowsDark(false)
    expect(win.background).toBe(GROUND['light-owl'])
  })

  it('ignores a Windows change when a theme is chosen outright', () => {
    const native = new FakeNativeTheme()
    const win = new FakeWindow()
    const theme = new WindowTheme(native, () => win)
    theme.apply(choose('dark'))
    native.setWindowsDark(false)
    expect(win.background).toBe(GROUND.dark)
    theme.apply(choose('light'))
    native.setWindowsDark(true)
    expect(win.background).toBe(GROUND.light)
    theme.apply(choose('night-owl'))
    native.setWindowsDark(false)
    expect(win.background).toBe(GROUND['night-owl'])
  })

  it('leaves a closed window alone, and stops listening once disposed', () => {
    const native = new FakeNativeTheme()
    const win = new FakeWindow()
    const theme = new WindowTheme(native, () => win)
    theme.apply(choose('system'))
    win.destroyed = true
    native.setWindowsDark(true)
    expect(win.background).toBe(GROUND.light)

    win.destroyed = false
    theme.dispose()
    native.setWindowsDark(false)
    native.setWindowsDark(true)
    expect(win.background).toBe(GROUND.light)
  })
})
