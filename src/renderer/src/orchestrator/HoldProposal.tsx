import { Anchor, Checkbox, Stack, Text, TextInput } from '@mantine/core'
import type { ReactElement } from 'react'
import type { HoldPayload, HoldResult } from '../../../shared/proposals'
import { dateInputValue, fromDateInput, shortDay } from '../../../shared/hold'
import { useMainbus } from '../store'
import type { ProposalView } from './proposalView'

/** The Override editor's state: a day, as a date input holds it, or none. */
interface HoldEdit {
  noDate: boolean
  day: string
}

function until(iso: string | null): string {
  return iso === null ? 'until you release it' : `until ${shortDay(iso, new Date())}`
}

function Body({ payload }: { payload: HoldPayload }): ReactElement {
  return (
    <Stack gap={2}>
      <Text size="sm">{`#${payload.number} ${payload.title}`}</Text>
      <Text size="sm">{`Held ${until(payload.until)}`}</Text>
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{`Why: ${payload.reason}`}</Text>
      <Text size="sm" c="dimmed">
        An agent already working on it keeps going; unattended mode and start proposals leave it alone.
      </Text>
    </Stack>
  )
}

function Editor({ value, onChange }: { value: HoldEdit; onChange: (v: HoldEdit) => void }): ReactElement {
  return (
    <Stack gap="xs">
      <Checkbox label="No date" checked={value.noDate} onChange={(e) => onChange({ ...value, noDate: e.currentTarget.checked })} />
      <TextInput
        type="date"
        label="Hold until"
        disabled={value.noDate}
        value={value.day}
        onChange={(e) => onChange({ ...value, day: e.currentTarget.value })}
      />
    </Stack>
  )
}

function Receipt({ result }: { result: HoldResult }): ReactElement {
  const openTicket = useMainbus((s) => s.openTicket)
  return (
    <Text size="sm" c="dimmed">
      {'Held '}
      <Anchor component="button" type="button" size="sm" title={result.title} onClick={() => openTicket(result.ticketId)}>
        #{result.number}
      </Anchor>
      {` ${until(result.until)}`}
    </Text>
  )
}

export const holdView: ProposalView<HoldPayload, HoldResult, HoldEdit> = {
  summary: (p) => `Hold #${p.number} ${p.title}`,
  Body,
  initialEdit: (p) => ({ noDate: p.until === null, day: dateInputValue(p.until === null ? new Date() : new Date(p.until)) }),
  Editor,
  toOverride(edit) {
    if (edit.noDate) return { until: null }
    const day = fromDateInput(edit.day)
    return day === null ? null : { until: day.toISOString() }
  },
  Receipt
}
