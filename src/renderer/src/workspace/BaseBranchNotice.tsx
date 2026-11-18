import { Stack, Text } from '@mantine/core'
import type { ReactElement } from 'react'
import type { BaseBranchWarning } from '../../../shared/api'

/** Says why a base branch other than main deserves a second look. Part of the base branch step of Add workspace. */
export function BaseBranchNotice({ warning, withHint }: { warning: BaseBranchWarning; withHint?: boolean }): ReactElement {
  return (
    <Stack gap="xs">
      {warning.restored ? (
        <Text>
          This workspace comes back with its old base branch, {warning.branch}. Every ticket starts from it and pull
          requests go into it. Usually that's main.
        </Text>
      ) : (
        <Text>
          Mainbus uses this branch as the workspace's base: every ticket starts from it and pull requests go into it.
          Usually that's main.
        </Text>
      )}
      {warning.notOnRemote && <Text>This branch isn't on origin, so pull requests will fail.</Text>}
      {withHint && !warning.restored && (
        <Text size="sm" c="dimmed">
          To use another branch, cancel, switch to it (for example git switch main) and add the folder again.
        </Text>
      )}
    </Stack>
  )
}
