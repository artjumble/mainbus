import { Box } from '@mantine/core'
import type { ReactElement } from 'react'
import type { RailColor } from '../../../shared/railBadge'
import classes from './WorkspaceRail.module.css'

/**
 * A workspace's rail tile: its short label on a rounded tile in its colour. The label is drawn from an attribute, not
 * written as text (see the stylesheet), and the tile is hidden from assistive technology: the workspace's name says it.
 */
export function RailTile({ label, color, bold }: { label: string; color: RailColor; bold?: boolean }): ReactElement {
  return (
    <Box
      aria-hidden
      className={classes.initials}
      data-initials={label}
      data-rail-color={color}
      style={{
        flexShrink: 0,
        minWidth: 28,
        height: 24,
        padding: '0 3px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        borderRadius: 'var(--mantine-radius-sm)',
        border: `1px solid var(--mainbus-rail-${color}-fg)`,
        background: `var(--mainbus-rail-${color}-bg)`,
        color: `var(--mainbus-rail-${color}-fg)`,
        fontSize: 11,
        lineHeight: 1,
        fontWeight: bold ? 800 : 700,
        whiteSpace: 'nowrap'
      }}
    />
  )
}
