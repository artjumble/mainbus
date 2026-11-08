import { Button, Group, Modal, Stack, Text } from '@mantine/core'
import { useState, type ReactElement } from 'react'

interface Props {
  opened: boolean
  /** The base branch's name. */
  base: string
  behind: number
  /** The role whose open run (paused or waiting) the update ends; null when no run is open. */
  openRole: string | null
  onClose: () => void
  /** Starts the update; resolves true once it has. */
  onUpdate: () => Promise<boolean>
}

/** The confirmation before Update from main: says what the Implementer does, and what becomes of an open run. */
export function UpdateFromMainModal({ opened, base, behind, openRole, onClose, onUpdate }: Props): ReactElement {
  const [updating, setUpdating] = useState(false)

  async function update(): Promise<void> {
    setUpdating(true)
    try {
      if (await onUpdate()) onClose()
    } finally {
      setUpdating(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title={`Update from ${base}`}>
      <Stack gap="md">
        <Text size="sm">
          {`The Implementer merges ${base} (${behind} new commit${behind === 1 ? '' : 's'}) into this branch, resolves any conflicts, runs the type check and the related tests, and commits. The pull request is updated when it hands off.`}
        </Text>
        {openRole !== null && (
          <Text size="sm">
            {`The ${openRole}'s run ends first (it counts as stopped). The ticket goes to Review afterwards, and Start again runs the lineup from a summary.`}
          </Text>
        )}
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose} disabled={updating}>
            Cancel
          </Button>
          <Button onClick={() => void update()} loading={updating}>
            Update from main
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
