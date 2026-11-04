import { describe, expect, it } from 'vitest'
import { GROUND } from '../shared/domain'
import { WindowTheme, windowBackground, type NativeThemePort, type ThemedWindow } from './windowTheme'

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

describe('windowBackground', () => {
  it.each([
    ['light', false, GROUND.light],
    ['light', true, GROUND.light],
    ['dark', false, GROUND.dark],
    ['dark', true, GROUND.dark],
    ['system', false, GROUND.light],
    ['system', true, GROUND.dark]
  ] as const)('%s with Windows dark %s paints %s', (choice, systemDark, expected) => {
    expect(windowBackground(choice, systemDark)).toBe(expected)
  })
})

describe('WindowTheme', () => {
  it('sets the native theme source to the choice, so the frame and menus agree, and paints the window', () => {
    const native = new FakeNativeTheme()
    native.windowsDark = true
    const win = new FakeWindow()
    const theme = new WindowTheme(native, () => win)

    theme.apply('light')
    expect(native.themeSource).toBe('light')
    expect(win.background).toBe(GROUND.light)
    expect(theme.background()).toBe(GROUND.light)

    theme.apply('dark')
    expect(native.themeSource).toBe('dark')
    expect(win.background).toBe(GROUND.dark)

    theme.apply('system')
    expect(native.themeSource).toBe('system')
    expect(win.background).toBe(GROUND.dark)
  })

  it('gives a new window the ground of the choice before it has loaded anything', () => {
    const native = new FakeNativeTheme()
    const theme = new WindowTheme(native, () => null)
    theme.apply('dark')
    expect(theme.background()).toBe(GROUND.dark)
  })

  it('with Match Windows, follows the Windows setting while the app runs', () => {
    const native = new FakeNativeTheme()
    const win = new FakeWindow()
    const theme = new WindowTheme(native, () => win)
    theme.apply('system')
    expect(win.background).toBe(GROUND.light)

    native.setWindowsDark(true)
    expect(win.background).toBe(GROUND.dark)
    expect(theme.background()).toBe(GROUND.dark)

    native.setWindowsDark(false)
    expect(win.background).toBe(GROUND.light)
  })

  it('ignores a Windows change when Light or Dark is chosen', () => {
    const native = new FakeNativeTheme()
    const win = new FakeWindow()
    const theme = new WindowTheme(native, () => win)
    theme.apply('dark')
    native.setWindowsDark(false)
    expect(win.background).toBe(GROUND.dark)
    theme.apply('light')
    native.setWindowsDark(true)
    expect(win.background).toBe(GROUND.light)
  })

  it('leaves a closed window alone, and stops listening once disposed', () => {
    const native = new FakeNativeTheme()
    const win = new FakeWindow()
    const theme = new WindowTheme(native, () => win)
    theme.apply('system')
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
