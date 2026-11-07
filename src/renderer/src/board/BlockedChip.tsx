import { Badge } from '@mantine/core'
import type { ReactElement } from 'react'
import type { Blocker } from '../../../shared/domain'
import { blockedLabel, openBlockers } from '../../../shared/dependencies'
import { WRAPPING_CHIP } from './chipStyles'

/** "Blocked by #39" on a ticket's card while a blocker isn't Done; nothing once they all are, or on a Done ticket. */
export function BlockedChip({ blockedBy, done = false }: { blockedBy: Blocker[]; done?: boolean }): ReactElement | null {
  const open = openBlockers(blockedBy)
  if (open.length === 0 || done) return null
  return (
    <Badge
      color="gray"
      variant="outline"
      size="sm"
      radius="sm"
      title={open.map((b) => `#${b.number} ${b.title}`).join('\n')}
      data-blocked-chip
      {...WRAPPING_CHIP}
    >
      <span aria-hidden>– </span>
      {blockedLabel(open)}
    </Badge>
  )
}
