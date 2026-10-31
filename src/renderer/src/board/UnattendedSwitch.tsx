import { Group, Switch, Text } from '@mantine/core'
import { useState, type ReactElement } from 'react'
import type { UnattendedStatus } from '../../../shared/domain'
import { showError } from '../notify'
import { useMainbus } from '../store'

function hhmm(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function unattendedText(status: UnattendedStatus): string {
  switch (status.kind) {
    case 'off':
      return 'Off'
    case 'starting':
      return 'Looking for a Ready ticket'
    case 'working':
      return `Working on #${status.ticketNumber}`
    case 'waiting':
      return `Waiting for the usage limit to reset at ${hhmm(status.until)}`
    case 'stopped':
      return `Stopped: ${status.reason}`
  }
}

/** The board header's switch for unattended mode, with one line saying what it is doing. */
export function UnattendedSwitch(): ReactElement {
  const state = useMainbus((s) => s.unattended)
  const setUnattended = useMainbus((s) => s.setUnattended)
  const [pending, setPending] = useState(false)

  async function toggle(on: boolean): Promise<void> {
    setPending(true)
    try {
      await setUnattended(on)
    } catch (err) {
      showError(err, on ? "Can't switch on unattended mode" : "Can't switch off unattended mode")
    } finally {
      setPending(false)
    }
  }

  return (
    <Group gap="xs" wrap="nowrap">
      <Switch
        label="Unattended"
        checked={state.on}
        disabled={pending}
        onChange={(e) => void toggle(e.currentTarget.checked)}
      />
      <Text size="sm" c="dimmed" data-testid="unattended-status">
        {unattendedText(state.status)}
      </Text>
    </Group>
  )
}
