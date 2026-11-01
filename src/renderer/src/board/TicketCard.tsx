import { Anchor, Badge, Group, Loader, Paper, Text } from '@mantine/core'
import { memo, type KeyboardEvent, type ReactElement } from 'react'
import type { Phase, PullRequest, TicketState } from '../../../shared/domain'
import type { BoardTicket } from '../store'
import { AgentBadge } from './AgentBadge'

const PHASE_LABELS: Partial<Record<Phase, string>> = {
  not_started: 'Not started',
  implementing: 'Implementing',
  reviewing: 'Reviewing',
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
  if (phase === 'planning' || phase === 'implementing' || phase === 'testing' || phase === 'reviewing') return 'working'
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

/** "PR #N", opening the pull request in the user's browser (the main process sends new windows there). */
export function PrLink({ pr, size = 'xs' }: { pr: PullRequest; size?: 'xs' | 'sm' }): ReactElement {
  return (
    <Anchor
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      size={size}
      // Inside a card, the link opens the PR, not the ticket.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      PR #{pr.number}
    </Anchor>
  )
}

interface Props {
  ticket: BoardTicket
  /** True while the card has been moved to Done and the engine is still removing its worktree. */
  cleaningUp?: boolean
  onOpen: (id: string) => void
}

/**
 * A board card: number, title and phase chip, a badge when an agent filed the ticket, a link to its pull request
 * once there is one, and a one-line summary in Needs you. Nothing else, by design.
 */
export const TicketCard = memo(function TicketCard({ ticket, cleaningUp = false, onOpen }: Props): ReactElement {
  const { state } = ticket
  const source = ticket.intent[0]?.source

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
        {source && <AgentBadge source={source} />}
        {ticket.pr && <PrLink pr={ticket.pr} />}
        {cleaningUp && (
          <Badge color="gray" variant="outline" size="sm" radius="sm" leftSection={<Loader size={8} color="gray" />}>
            Cleaning up…
          </Badge>
        )}
      </Group>
      {state.column === 'needs_you' && state.summary && (
        <Text size="xs" c="dimmed" mt={6} lineClamp={1}>
          {state.summary}
        </Text>
      )}
    </Paper>
  )
})
