import { Button, Group, Menu, Modal, Stack, TextInput } from '@mantine/core'
import { useState, type ReactElement } from 'react'
import { dateInputValue, fromDateInput, nextMonday, tomorrow } from '../../../shared/hold'

interface Props {
  disabled: boolean
  /** Holds the ticket until `until` (an ISO date-time), or with no date; resolves true once it is held. */
  onHold: (until: string | null) => Promise<boolean>
}

/** "Hold…": quick picks for how long (No date, Tomorrow, Monday, Pick a date). */
export function HoldMenu({ disabled, onHold }: Props): ReactElement {
  const [picking, setPicking] = useState(false)
  return (
    <>
      <Menu position="bottom-start">
        <Menu.Target>
          <Button size="compact-sm" variant="default" disabled={disabled}>
            Hold…
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={() => void onHold(null)}>No date</Menu.Item>
          <Menu.Item onClick={() => void onHold(tomorrow(new Date()).toISOString())}>Tomorrow</Menu.Item>
          <Menu.Item onClick={() => void onHold(nextMonday(new Date()).toISOString())}>Monday</Menu.Item>
          <Menu.Item onClick={() => setPicking(true)}>Pick a date</Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <PickDateModal opened={picking} onClose={() => setPicking(false)} onHold={onHold} />
    </>
  )
}

function PickDateModal({ opened, onClose, onHold }: { opened: boolean; onClose: () => void; onHold: Props['onHold'] }): ReactElement {
  const [value, setValue] = useState(() => dateInputValue(tomorrow(new Date())))
  const [saving, setSaving] = useState(false)
  const date = fromDateInput(value)
  const future = date !== null && date.getTime() > Date.now()

  async function hold(): Promise<void> {
    if (!date || !future) return
    setSaving(true)
    try {
      if (await onHold(date.toISOString())) onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Hold until a date">
      <Stack gap="md">
        <TextInput
          type="date"
          label="Hold until"
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          error={value !== '' && !future ? 'Pick a day after today' : undefined}
        />
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void hold()} loading={saving} disabled={!future}>
            Hold
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
