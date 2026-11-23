import { Button, Group, Modal, Stack, Text } from '@mantine/core'
import { useState, type ReactElement } from 'react'

/** The effect of handing a ticket to agents, in the words every place that asks uses. */
export const HAND_TO_AGENTS_EFFECT = 'Agents can then work on it. Start and Run settings come back, and unattended mode may start it if it is in Ready.'

/** Asks before a ticket the user owns goes to agents. `onConfirm` resolves true once it is handed over; the modal then closes. */
export function HandToAgentsModal({
  number,
  opened,
  onClose,
  onConfirm,
  returnFocus = true
}: {
  number: number
  opened: boolean
  onClose: () => void
  onConfirm: () => Promise<boolean>
  /** False when the control that opened it is gone by the time it closes. */
  returnFocus?: boolean
}): ReactElement {
  const [handing, setHanding] = useState(false)
  return (
    <Modal opened={opened} onClose={onClose} title={`Hand #${number} to agents?`} returnFocus={returnFocus}>
      <Stack gap="md">
        <Text size="sm">{HAND_TO_AGENTS_EFFECT}</Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="default" data-autofocus onClick={onClose} disabled={handing}>
            Cancel
          </Button>
          <Button
            loading={handing}
            onClick={() => {
              setHanding(true)
              void onConfirm().then((ok) => {
                setHanding(false)
                if (ok) onClose()
              })
            }}
          >
            Hand to agents
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
