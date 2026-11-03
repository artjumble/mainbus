import { Badge } from '@mantine/core'
import type { ReactElement } from 'react'
import type { Hold } from '../../../shared/domain'
import { holdLabel } from '../../../shared/hold'

/** "Held by you" or "Held until Tue", on a held ticket's card and in its header; nothing when it isn't held. */
export function HoldChip({ hold, now = new Date() }: { hold: Hold | null; now?: Date }): ReactElement | null {
  if (!hold) return null
  return (
    <Badge color="gray" variant="outline" size="sm" radius="sm" data-hold-chip>
      <span aria-hidden>– </span>
      {holdLabel(hold, now)}
    </Badge>
  )
}
