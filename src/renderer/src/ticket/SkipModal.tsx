import { Button, Group, Modal, Stack, Text } from '@mantine/core'
import { useState, type ReactElement } from 'react'

interface Props {
  opened: boolean
  /** The active role, which Skip ends. */
  role: string
  /** The role Skip starts next; null on the last role, when the ticket goes to Review instead. */
  next: string | null
  onClose: () => void
  /** Skips the role; resolves true once it has. */
  onSkip: () => Promise<boolean>
}

/** The confirmation before Skip to next role: says what becomes of the role's work. */
export function SkipModal({ opened, role, next, onClose, onSkip }: Props): ReactElement {
  const [skipping, setSkipping] = useState(false)

  async function skip(): Promise<void> {
    setSkipping(true)
    try {
      if (await onSkip()) onClose()
    } finally {
      setSkipping(false)
    }
  }

  const text =
    next === null
      ? `Skip the ${role}? Its work so far is summarised and the ticket goes to Review.`
      : `Skip the ${role}? Its work so far is summarised for the ${next}.`
  return (
    <Modal opened={opened} onClose={onClose} title="Skip to next role">
      <Stack gap="md">
        <Text size="sm">{text}</Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose} disabled={skipping}>
            Cancel
          </Button>
          <Button onClick={() => void skip()} loading={skipping}>
            Skip
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
