/** Chip props for a narrow board column: sentence case, and the text wraps instead of being cut off, so the state stays readable. */
export const WRAPPING_CHIP = {
  tt: 'none',
  styles: { root: { height: 'auto', paddingBlock: 2 }, label: { whiteSpace: 'normal', overflow: 'visible', textOverflow: 'clip' } }
} as const
