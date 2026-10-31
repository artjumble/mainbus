import { Badge, Group, Paper, Text } from '@mantine/core'
import { memo, type KeyboardEvent, type ReactElement } from 'react'
import type { Phase, TicketState } from '../../../shared/domain'
import type { BoardTicket } from '../store'

const PHASE_LABELS: Partial<Record<Phase, string>> = {
  not_started: 'Not started',
  implementing: 'Implementing',
  waiting_on_you: 'Waiting on you',
  ready_for_review: 'Ready for review',
  done: 'Done'
}

/** "Not started" for the MVP phases, title case for any other (planning, testing). */
export function phaseLabel(phase: Phase): string {
  return (
    PHASE_LABELS[phase] ??
    phase
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  )
}

function chipColor({ phase, agentStatus }: TicketState): string {
  if (phase === 'waiting_on_you' || agentStatus === 'failed') return 'needs'
  if (phase === 'planning' || phase === 'implementing' || phase === 'testing') return 'working'
  return 'gray'
}

/** The phase chip: orange when the person is needed, blue while an agent works, grey otherwise. */
export function PhaseChip({ state }: { state: TicketState }): ReactElement {
  return (
    <Badge color={chipColor(state)} variant="light" size="sm" radius="sm">
      {phaseLabel(state.phase)}
    </Badge>
  )
}

interface Props {
  ticket: BoardTicket
  onOpen: (id: string) => void
}

/** A board card: number, title and phase chip, plus a one-line summary in Needs you. Nothing else, by design. */
export const TicketCard = memo(function TicketCard({ ticket, onOpen }: Props): ReactElement {
  const { state } = ticket

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen(ticket.id)
    }
  }

  return (
    <Paper
      withBorder
      p="sm"
      radius="md"
      shadow="xs"
      role="button"
      tabIndex={0}
      style={{ cursor: 'pointer' }}
      onClick={() => onOpen(ticket.id)}
      onKeyDown={onKeyDown}
    >
      <Text size="xs" c="dimmed">
        #{ticket.number}
      </Text>
      <Text fw={500} size="sm" mb={6}>
        {ticket.title}
      </Text>
      <Group gap="xs">
        <PhaseChip state={state} />
      </Group>
      {state.column === 'needs_you' && state.summary && (
        <Text size="xs" c="dimmed" mt={6} lineClamp={1}>
          {state.summary}
        </Text>
      )}
    </Paper>
  )
})
