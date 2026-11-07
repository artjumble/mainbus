import { Button, Group, Modal, Stack, Text } from '@mantine/core'
import type { ReactElement } from 'react'
import { notDoneYetText } from '../../../shared/dependencies'
import type { Blocker } from '../../../shared/domain'

interface Props {
  opened: boolean
  /** The blockers that aren't Done. */
  open: Blocker[]
  onClose: () => void
  /** Starts the ticket anyway. */
  onStart: () => void
}

/** The question before Start on a ticket whose blockers aren't all Done. */
export function StartBlockedModal({ opened, open, onClose, onStart }: Props): ReactElement {
  return (
    <Modal opened={opened} onClose={onClose} title="Blocked ticket">
      <Stack gap="md">
        <Text size="sm">{open.length > 0 ? `${notDoneYetText(open)}. Start anyway?` : 'Start anyway?'}</Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onStart}>Start anyway</Button>
        </Group>
      </Stack>
    </Modal>
  )
}
