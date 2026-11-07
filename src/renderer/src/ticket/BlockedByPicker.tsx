import { MultiSelect } from '@mantine/core'
import type { ReactElement } from 'react'
import { useMainbus } from '../store'

interface Props {
  /** The ids of the tickets that block it. */
  value: string[]
  onChange: (ids: string[]) => void
  /** The ticket being edited, which can't block itself; absent for a ticket not created yet. */
  ticketId?: string
  disabled?: boolean
}

/** A searchable picker of the workspace's other tickets, by number and title; Done ones say so. */
export function BlockedByPicker({ value, onChange, ticketId, disabled }: Props): ReactElement {
  const tickets = useMainbus((s) => s.tickets)
  const data = tickets
    .filter((t) => t.id !== ticketId)
    .map((t) => ({ value: t.id, label: `#${t.number} ${t.title}${t.manualColumn === 'done' ? ' (Done)' : ''}` }))
  return (
    <MultiSelect
      label="Blocked by"
      description="Tickets that should be Done before this one starts."
      placeholder={value.length === 0 ? 'None' : undefined}
      data={data}
      value={value}
      onChange={onChange}
      searchable
      clearable
      nothingFoundMessage="No other tickets"
      disabled={disabled}
      comboboxProps={{ withinPortal: true }}
      data-blocked-by-picker
    />
  )
}
