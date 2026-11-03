import { Alert, Badge, List, Text } from '@mantine/core'
import type { ReactElement } from 'react'
import type { StuckEpisode } from '../../../shared/domain'
import { WRAPPING_CHIP } from './chipStyles'

/** "Looks stuck", on a card and in the ticket header, while the ticket's open run has an open stuck episode. */
export function StuckChip({ stuck }: { stuck: StuckEpisode | null }): ReactElement | null {
  if (!stuck) return null
  return (
    <Badge color="needs" variant="light" size="sm" radius="sm" data-stuck-chip {...WRAPPING_CHIP}>
      Looks stuck
    </Badge>
  )
}

/** What the detector saw, in the ticket view; from the third hit it asks for a closer look. */
export function StuckEvidence({ stuck }: { stuck: StuckEpisode | null }): ReactElement | null {
  if (!stuck) return null
  return (
    <Alert color="needs" variant="light" p="xs" title={stuck.needsCloserLook ? 'Looks stuck: needs a closer look' : 'Looks stuck'} data-stuck-evidence>
      <List size="sm" spacing={2} listStyleType="disc">
        {stuck.evidence.map((line, i) => (
          <List.Item key={i}>{line}</List.Item>
        ))}
      </List>
      {stuck.hitCount > 1 && (
        <Text size="xs" c="dimmed" mt={4}>
          Seen {stuck.hitCount} times.
        </Text>
      )}
    </Alert>
  )
}
