import { Alert, Button, Group } from '@mantine/core'
import type { ReactElement } from 'react'
import { usageBannerText } from '../../shared/usage'
import { invoke } from './api'
import { showError } from './notify'
import { useMainbus } from './store'

/** Above the board and the ticket view: the usage limit has paused the agents, or is close and holds new ones back. */
export function UsageBanner(): ReactElement {
  const usage = useMainbus((s) => s.usage)
  const limited = usage.kind === 'limited'
  // The status region stays mounted, so a banner that appears is announced, once, and politely.
  return (
    <div role="status" aria-label="Usage limit">
      {usage.kind !== 'ok' && (
        <Alert color={limited ? 'red' : 'yellow'} variant="light" radius={0} py="xs">
          <Group justify="space-between" wrap="nowrap">
            <span>{usageBannerText(usage)}</span>
            {limited && (
              <Button size="compact-sm" variant="default" onClick={() => void invoke('usage.resumeNow').catch((err: unknown) => showError(err, 'Could not resume'))}>
                Resume now
              </Button>
            )}
          </Group>
        </Alert>
      )}
    </div>
  )
}
