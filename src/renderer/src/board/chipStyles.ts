/** Chip props for a narrow board column: sentence case, and the text wraps instead of being cut off, so the state stays readable. */
export const WRAPPING_CHIP = {
  tt: 'none',
  styles: { root: { height: 'auto', paddingBlock: 2 }, label: { whiteSpace: 'normal', overflow: 'visible', textOverflow: 'clip' } }
} as const

/** The colour and variant of the "Conflicts with main" chip, and of the ticket view's Update from main button while the branch conflicts: one place, so they can't drift apart. */
export const CONFLICT_LOOK = { color: 'needs', variant: 'light' } as const
