import { Alert, Button, Group } from '@mantine/core'
import type { ReactElement } from 'react'
import { usageBannerText } from '../../shared/usage'
import { invoke } from './api'
import { showError } from './notify'
import { useMainbus } from './store'

/** Above the board and the ticket view: the usage limit has paused the agents, or is close and holds new ones back. */
export function UsageBanner(): ReactElement | null {
  const usage = useMainbus((s) => s.usage)
  if (usage.kind === 'ok') return null
  const limited = usage.kind === 'limited'
  return (
    <Alert color={limited ? 'red' : 'yellow'} variant="light" radius={0} py="xs" role="status" aria-label="Usage limit">
      <Group justify="space-between" wrap="nowrap">
        <span>{usageBannerText(usage)}</span>
        {limited && (
          <Button size="compact-sm" variant="default" onClick={() => void invoke('usage.resumeNow').catch((err: unknown) => showError(err, 'Could not resume'))}>
            Resume now
          </Button>
        )}
      </Group>
    </Alert>
  )
}
