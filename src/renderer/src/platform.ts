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

/** A shortcut for a hint, such as `shortcut('K')` → "⌘K" on macOS and "Ctrl+K" elsewhere. */
export function shortcut(...keys: string[]): string {
  return isMac() ? `⌘${keys.join('')}` : [modLabel(), ...keys].join('+')
}
