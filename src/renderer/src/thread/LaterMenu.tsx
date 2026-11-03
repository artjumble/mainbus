import { Button, Group, Menu, TextInput } from '@mantine/core'
import { useState, type ReactElement } from 'react'
import type { Decision } from '../../../shared/domain'
import { atNine, dateInputValue, fromDateInput, laterMonday, laterTomorrow, tomorrow } from '../../../shared/hold'
import { invoke } from '../api'
import { asOwnChange } from '../board/ownChanges'
import { showAgentError } from './agentError'

/** Defers the decision until `until` (ISO); resolves false (after showing why) when the engine refused. */
export async function deferDecision(decision: Decision, until: string): Promise<boolean> {
  try {
    await asOwnChange(decision.ticketId, () => invoke('decision.defer', decision.id, until))
    return true
  } catch (err) {
    showAgentError(err, 'Could not put this off')
    return false
  }
}

/**
 * "Later…" on a decision card: Tomorrow and Monday (09:00 local) and Pick a date, which shows a date input right
 * here rather than in a modal (a modal would be an outside click to the board's popover). The menu isn't portaled
 * for the same reason.
 */
export function LaterMenu({ decision, onDeferred }: { decision: Decision; onDeferred?: () => void }): ReactElement {
  const [picking, setPicking] = useState(false)
  const [value, setValue] = useState(() => dateInputValue(tomorrow(new Date())))
  const [busy, setBusy] = useState(false)
  const day = fromDateInput(value)
  const at = day === null ? null : atNine(day)
  const future = at !== null && at.getTime() > Date.now()

  async function defer(until: Date): Promise<void> {
    if (busy) return
    setBusy(true)
    const ok = await deferDecision(decision, until.toISOString())
    setBusy(false)
    if (ok) {
      setPicking(false)
      onDeferred?.()
    }
  }

  return (
    <>
      <Menu position="bottom-start" withinPortal={false}>
        <Menu.Target>
          <Button size="compact-sm" variant="default" w="fit-content" disabled={busy}>
            Later…
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={() => void defer(laterTomorrow(new Date()))}>Tomorrow</Menu.Item>
          <Menu.Item onClick={() => void defer(laterMonday(new Date()))}>Monday</Menu.Item>
          <Menu.Item onClick={() => setPicking(true)}>Pick a date</Menu.Item>
        </Menu.Dropdown>
      </Menu>
      {picking && (
        <Group gap="xs" align="flex-end">
          <TextInput
            type="date"
            size="xs"
            label="Put off until"
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            error={value !== '' && !future ? 'Pick a day after today' : undefined}
          />
          <Button size="compact-sm" loading={busy} disabled={!future} onClick={() => at && void defer(at)}>
            Defer
          </Button>
        </Group>
      )}
    </>
  )
}
