import { Box } from '@mantine/core'
import type { ReactElement, ReactNode } from 'react'

/** The width of the Save column, shared by every setting row so the buttons and the inputs' right edges line up. */
export const SAVE_COLUMN_WIDTH = 150

/**
 * One settings row: the input (with its label above it) in the first column, and its Save button, if it has one, in the
 * second. The button is bottom-aligned with the input, and is as wide as every other row's. A row with no Save button
 * keeps the column empty, so its input ends where the others do.
 */
export function SettingRow({ children, save }: { children: ReactNode; save?: ReactNode }): ReactElement {
  return (
    <Box
      data-setting-row
      style={{
        display: 'grid',
        gridTemplateColumns: `minmax(0, 1fr) ${SAVE_COLUMN_WIDTH}px`,
        columnGap: 'var(--mantine-spacing-sm)',
        alignItems: 'end'
      }}
    >
      {children}
      {save ?? <span />}
    </Box>
  )
}
