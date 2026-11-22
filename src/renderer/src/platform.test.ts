import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasMod, modLabel, shortcut } from './platform'

function on(platform: string): void {
  vi.stubGlobal('navigator', { platform, userAgent: platform })
}
afterEach(() => vi.unstubAllGlobals())

describe('platform modifier', () => {
  it('uses ⌘ on macOS', () => {
    on('MacIntel')
    expect(modLabel()).toBe('⌘')
    expect(shortcut('K')).toBe('⌘K')
    expect(shortcut('Shift', 'Space')).toBe('⌘ShiftSpace')
    expect(hasMod({ metaKey: true, ctrlKey: false })).toBe(true)
    expect(hasMod({ metaKey: false, ctrlKey: true })).toBe(false)
  })
  it('uses Ctrl on Windows and Linux', () => {
    for (const p of ['Win32', 'Linux x86_64']) {
      on(p)
      expect(modLabel()).toBe('Ctrl')
      expect(shortcut('K')).toBe('Ctrl+K')
      expect(shortcut('Shift', 'Space')).toBe('Ctrl+Shift+Space')
      expect(hasMod({ metaKey: false, ctrlKey: true })).toBe(true)
      expect(hasMod({ metaKey: true, ctrlKey: false })).toBe(false)
    }
  })
})
