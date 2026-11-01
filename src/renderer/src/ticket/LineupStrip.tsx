import { Group, Paper, Text } from '@mantine/core'
import { Fragment, type ReactElement } from 'react'
import type { RoleStatus, StripRole } from '../../../shared/domain'

export const ROLE_STATUS_LABELS: Record<RoleStatus, string> = {
  not_started: 'Not started',
  working: 'Working',
  waiting_on_you: 'Waiting on you',
  handed_off: 'Handed off',
  paused: 'Paused',
  failed: 'Failed',
  stopped: 'Stopped'
}

function statusColor(status: RoleStatus): string {
  if (status === 'waiting_on_you' || status === 'failed') return 'needs.7'
  if (status === 'working') return 'working.7'
  return 'dimmed'
}

/** The ticket run's roles in order, each with where it stands; the active one is highlighted. */
export function LineupStrip({ roles }: { roles: StripRole[] }): ReactElement {
  return (
    <Group role="list" aria-label="Lineup" gap="xs" px="md" py="xs" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
      {roles.map((role, i) => (
        <Fragment key={role.id}>
          {i > 0 && (
            <Text size="sm" c="dimmed" aria-hidden>
              →
            </Text>
          )}
          <Paper
            role="listitem"
            aria-current={role.active ? 'step' : undefined}
            withBorder
            radius="sm"
            px="sm"
            py={4}
            style={
              role.active
                ? { borderColor: 'var(--mantine-color-working-6)', background: 'var(--mantine-color-working-light)' }
                : undefined
            }
          >
            <Text size="sm" fw={role.active ? 700 : 500} lh={1.3}>
              {role.name}
            </Text>
            <Text size="xs" c={statusColor(role.status)} lh={1.3}>
              {ROLE_STATUS_LABELS[role.status]}
            </Text>
          </Paper>
        </Fragment>
      ))}
    </Group>
  )
}
