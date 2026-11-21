import { Group, Switch, Text } from '@mantine/core'
import { useState, type ReactElement } from 'react'
import type { UnattendedStatus } from '../../../shared/domain'
import { showError } from '../notify'
import { useMainbus } from '../store'

function hhmm(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "#4", "#4, #7", or "3 tickets" when the list would be long. */
function ticketList(numbers: number[]): string {
  return numbers.length <= 2 ? numbers.map((n) => `#${n}`).join(', ') : `${numbers.length} tickets`
}

/** The full list, for a tooltip, when the text only counts the tickets. */
function fullList(status: UnattendedStatus): string | undefined {
  if ((status.kind === 'working' || status.kind === 'other_working') && status.ticketNumbers.length > 2) {
    return status.ticketNumbers.map((n) => `#${n}`).join(', ')
  }
  return undefined
}

export function unattendedText(status: UnattendedStatus): string {
  switch (status.kind) {
    case 'off':
      return 'Off'
    case 'starting':
      return 'Looking for a Ready ticket'
    case 'working':
      return `Working on ${ticketList(status.ticketNumbers)}`
    case 'idle':
      return status.skipped ? 'No Ready ticket could be started; waiting for Ready tickets' : 'Waiting for Ready tickets'
    case 'other_working':
      return `Waiting for ${ticketList(status.ticketNumbers)} to finish`
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
      <Text size="sm" c="dimmed" data-testid="unattended-status" title={fullList(state.status)}>
        {unattendedText(state.status)}
      </Text>
    </Group>
  )
}
