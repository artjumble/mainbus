/** Props for a badge in a no-wrap row beside truncating text: it keeps its full width and its label is never cut short, so only the text gives up room. */
export const ROW_BADGE = {
  tt: 'none',
  styles: { root: { flexShrink: 0, overflow: 'visible' }, label: { overflow: 'visible', textOverflow: 'clip' } }
} as const
