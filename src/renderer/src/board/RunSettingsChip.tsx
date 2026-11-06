import { Badge } from '@mantine/core'
import type { ReactElement } from 'react'
import type { RunSettings } from '../../../shared/domain'
import { WRAPPING_CHIP } from './chipStyles'

/** "Custom run" on the card and in the header of a ticket with saved run settings; nothing when it has none. */
export function RunSettingsChip({ ticket }: { ticket: { runSettings: RunSettings | null } }): ReactElement | null {
  if (ticket.runSettings === null) return null
  return (
    <Badge color="gray" variant="outline" size="sm" radius="sm" data-run-settings-chip {...WRAPPING_CHIP}>
      Custom run
    </Badge>
  )
}
