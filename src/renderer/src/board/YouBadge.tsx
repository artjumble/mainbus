import { Badge } from '@mantine/core'
import type { ReactElement } from 'react'
import { WRAPPING_CHIP } from './chipStyles'

/** A person: head and shoulders, drawn in the badge's own color. */
function PersonIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" />
    </svg>
  )
}

/** "You", with a person icon: marks a ticket the user owns, so no agent starts on it. Shared by the board card and the ticket view. */
export function YouBadge(): ReactElement {
  return (
    <Badge
      data-you-badge
      variant="outline"
      size="sm"
      radius="sm"
      tt={WRAPPING_CHIP.tt}
      leftSection={<PersonIcon />}
      styles={{
        root: { ...WRAPPING_CHIP.styles.root, color: 'var(--mainbus-color-yours)', borderColor: 'var(--mainbus-color-yours)' },
        label: WRAPPING_CHIP.styles.label
      }}
    >
      You
    </Badge>
  )
}
