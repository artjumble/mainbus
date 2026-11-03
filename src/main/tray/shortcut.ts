export interface ShortcutDetails {
  target: string
  appUserModelId: string
}

/** True when the Start Menu shortcut must be written: it is missing, or points elsewhere or carries another app ID. */
export function shortcutNeedsWrite(existing: ShortcutDetails | null, wanted: ShortcutDetails): boolean {
  if (!existing) return true
  return existing.target.toLowerCase() !== wanted.target.toLowerCase() || existing.appUserModelId !== wanted.appUserModelId
}
