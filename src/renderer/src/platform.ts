/** The OS the app runs on. Falls back to Windows when the bridge isn't there (tests, a plain browser). */
export function platform(): string {
  return window.mainbus?.platform ?? 'win32'
}

/** The platform's shortcut modifier: ⌘ (Meta) on macOS, Ctrl elsewhere. Read at call time so tests can change the platform. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  return /Mac|iPhone|iPad/i.test(nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? '')
}

/** True when the event carries the platform modifier (⌘ on macOS, Ctrl elsewhere) and not the other one. */
export function hasMod(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

/** The modifier as shown in hints: "⌘" or "Ctrl". */
export function modLabel(): string {
  return isMac() ? '⌘' : 'Ctrl'
}

const MAC_SYMBOLS: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧' }
const MAC_ORDER = ['Ctrl', 'Alt', 'Option', 'Shift']

/**
 * A shortcut for a hint: `shortcut('K')` is "⌘K" on macOS and "Ctrl+K" elsewhere. Extra modifiers go before the key
 * (`shortcut('Shift', 'Space')`): "⇧⌘Space" on macOS, in Apple's order, and "Ctrl+Shift+Space" elsewhere.
 */
export function shortcut(...keys: string[]): string {
  if (!isMac()) return [modLabel(), ...keys].join('+')
  const key = keys[keys.length - 1]
  const mods = keys.slice(0, -1).sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b))
  return [...mods.map((m) => MAC_SYMBOLS[m] ?? m), '⌘', key].join('')
}

/** The same shortcut for `aria-keyshortcuts`: "Meta+Shift+Space" on macOS, "Control+Shift+Space" elsewhere. */
export function ariaShortcut(...keys: string[]): string {
  return [isMac() ? 'Meta' : 'Control', ...keys].join('+')
}
