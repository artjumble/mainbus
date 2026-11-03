import { Anchor, Badge, Group, Loader, Paper, Text, UnstyledButton } from '@mantine/core'
import { useReducedMotion } from '@mantine/hooks'
import { memo, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import type { Phase, PullRequest, TicketState } from '../../../shared/domain'
import { waitingLabel } from '../../../shared/hold'
import { queuedLabel } from '../../../shared/queue'
import type { BoardTicket } from '../store'
import { AgentBadge } from './AgentBadge'
import { BoardAnswer } from './BoardAnswer'
import { HoldChip } from './HoldChip'
import { StuckChip } from './StuckChip'
import classes from './TicketCard.module.css'

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

function chipColor({ phase, agentStatus, deferredUntil }: TicketState): string {
  // Only deferred decisions: the person isn't needed until the date.
  if (deferredUntil !== null) return 'gray'
  if (phase === 'waiting_on_you' || agentStatus === 'failed') return 'needs'
  if (phase === 'planning' || phase === 'implementing' || phase === 'testing' || phase === 'reviewing') return 'working'
  return 'gray'
}

/** The phase chip: orange when the person is needed, blue while an agent works, grey otherwise. */
export function PhaseChip({ state }: { state: TicketState }): ReactElement {
  return (
    <Badge color={chipColor(state)} variant="light" size="sm" radius="sm">
      {state.deferredUntil !== null ? waitingLabel(state.deferredUntil, new Date()) : phaseLabel(state.phase)}
    </Badge>
  )
}

/** "Paused", beside the phase chip, while the user or the usage limit has paused the active role. */
export function PausedChip({ state }: { state: TicketState }): ReactElement | null {
  if (!state.pausedByUser && !state.pausedByLimit) return null
  return (
    <Badge color="gray" variant="outline" size="sm" radius="sm">
      Paused
    </Badge>
  )
}

/** "Queued · 2nd", beside the phase chip, while every agent slot is in use and the ticket's agent waits for one. */
export function QueuedChip({ state }: { state: TicketState }): ReactElement | null {
  if (state.agentStatus !== 'queued') return null
  return (
    <Badge color="gray" variant="outline" size="sm" radius="sm" tt="none">
      {queuedLabel(state.queuePosition)}
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
    >
      PR #{pr.number}
    </Anchor>
  )
}

interface Props {
  ticket: BoardTicket
  /** True while the card has been moved to Done and the engine is still removing its worktree. */
  cleaningUp?: boolean
  /** When Mainbus last changed the card's column, phase or agent status (ms); it is outlined for a few seconds after. */
  changedAt?: number
  onOpen: (id: string) => void
  /** The card's drag handle, shown beside its number. */
  handle?: ReactNode
}

/** How long the outline fades, and how long it stays for people who prefer reduced motion. */
export const FADE_MS = 4000
export const STILL_MS = 1200

/** Whether the "recently changed" outline is still showing; it ends on its own, and a remount shows what is left. */
function useRecentlyChanged(changedAt: number | undefined, duration: number): boolean {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    setNow(Date.now())
    if (changedAt === undefined) return
    const left = changedAt + duration - Date.now()
    if (left <= 0) return
    const timer = setTimeout(() => setNow(Date.now()), left + 1)
    return () => clearTimeout(timer)
  }, [changedAt, duration])
  return changedAt !== undefined && now < changedAt + duration
}

/**
 * A board card: number, title and phase chip, a badge when an agent filed the ticket, a link to its pull request
 * once there is one, and in Needs you a one-line summary and an Answer control for a pending decision.
 */
export const TicketCard = memo(function TicketCard({ ticket, cleaningUp = false, changedAt, onOpen, handle }: Props): ReactElement {
  const { state } = ticket
  const source = ticket.intent[0]?.source
  const reducedMotion = useReducedMotion()
  const duration = reducedMotion ? STILL_MS : FADE_MS
  const recent = useRecentlyChanged(changedAt, duration)

  return (
    // A click on the card's empty area opens the ticket too, as a pointer convenience; the title is the control.
    <Paper
      withBorder
      p="sm"
      radius="md"
      shadow="xs"
      className={recent ? (reducedMotion ? classes.recentStill : classes.recent) : undefined}
      data-recently-changed={recent ? (reducedMotion ? 'still' : 'fade') : undefined}
      // Resumes the fade where it was when the card is shown again part-way through.
      style={{ cursor: 'pointer', ...(recent && !reducedMotion ? { animationDelay: `-${Date.now() - changedAt!}ms` } : {}) }}
      onClick={() => onOpen(ticket.id)}
    >
      <Text size="xs" c="dimmed">
        #{ticket.number}
      </Text>
      {/* The handle sits beside the title, not above it, so their 44 px hit areas don't overlap. */}
      <Group gap="xs" wrap="nowrap" align="flex-start" mb={6}>
        <UnstyledButton
          data-card-title={ticket.id}
          style={{ display: 'block', textAlign: 'left', flex: 1, minWidth: 0 }}
          onClick={(e) => {
            e.stopPropagation()
            onOpen(ticket.id)
          }}
        >
          <Text fw={500} size="sm">
            {ticket.title}
          </Text>
        </UnstyledButton>
        {handle}
      </Group>
      <Group gap="xs">
        <PhaseChip state={state} />
        <PausedChip state={state} />
        <QueuedChip state={state} />
        <HoldChip hold={ticket.hold} />
        <StuckChip stuck={ticket.stuck} />
        {ticket.kind === 'investigate' && (
          <Badge color="gray" variant="outline" size="sm" radius="sm">
            Investigate
          </Badge>
        )}
        {source && <AgentBadge source={source} />}
        {ticket.pr && <PrLink pr={ticket.pr} />}
        {cleaningUp && (
          <Badge color="gray" variant="outline" size="sm" radius="sm" leftSection={<Loader size={8} color="gray" />}>
            Cleaning up…
          </Badge>
        )}
      </Group>
      {(state.column === 'needs_you' || state.pausedByLimit) && state.summary && (
        <Text size="xs" c="dimmed" mt={6} lineClamp={1}>
          {state.summary}
        </Text>
      )}
      {state.column === 'needs_you' && <BoardAnswer decisions={ticket.pendingDecisions} />}
    </Paper>
  )
})
