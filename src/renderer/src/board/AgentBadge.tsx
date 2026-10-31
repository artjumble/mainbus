import { Badge, Tooltip } from '@mantine/core'
import type { ReactElement } from 'react'
import type { IntentSource } from '../../../shared/domain'

/** Marks words a local agent wrote: its self-reported name, with the folder it filed from in a tooltip. */
export function AgentBadge({ source }: { source: IntentSource }): ReactElement {
  return (
    <Tooltip label={`Filed from ${source.cwd || 'an unknown folder'}`} multiline maw={360} withArrow openDelay={300}>
      <Badge variant="outline" color="gray" size="sm" radius="sm" tt="none" maw="100%">
        from {source.agent} (reported)
      </Badge>
    </Tooltip>
  )
}
