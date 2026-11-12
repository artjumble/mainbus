import { Button, Group, Stack, Text } from '@mantine/core'
import type { ReactElement } from 'react'
import type { BaseBranchWarning } from '../../../shared/api'

/** Warns that the checked-out branch becomes the workspace's base, before the workspace is added. */
export function BaseBranchNotice({
  warning,
  busy,
  onAdd,
  onCancel
}: {
  warning: BaseBranchWarning
  busy?: boolean
  onAdd: () => void
  onCancel: () => void
}): ReactElement {
  return (
    <Stack gap="md">
      {warning.restored ? (
        <Text>
          This workspace comes back with its old base branch, {warning.branch}. Every ticket starts from it and pull
          requests go into it. Usually that's main.
        </Text>
      ) : (
        <Text>
          You're on {warning.branch}. Mainbus uses the checked-out branch as this workspace's base: every ticket starts
          from it and pull requests go into it. Usually that's main.
        </Text>
      )}
      {warning.notOnRemote && <Text>This branch isn't on origin, so pull requests will fail.</Text>}
      {!warning.restored && (
        <Text size="sm" c="dimmed">
          To use another branch, cancel, switch to it (for example git switch main) and add the folder again.
        </Text>
      )}
      <Group justify="flex-end">
        <Button variant="default" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onAdd} loading={busy}>
          Add anyway
        </Button>
      </Group>
    </Stack>
  )
}
