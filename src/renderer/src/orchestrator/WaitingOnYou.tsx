import { Anchor, Box, Button, Collapse, Group, Paper, Stack, Text, UnstyledButton } from '@mantine/core'
import { useMemo, useState, type ReactElement } from 'react'
import type { Decision } from '../../../shared/domain'
import { shortDay } from '../../../shared/hold'
import { invoke } from '../api'
import { asOwnChange } from '../board/ownChanges'
import { useMainbus, type BoardTicket } from '../store'
import { QuestionForm } from '../thread/DecisionCard'
import { showAgentError } from '../thread/agentError'
import { PermissionChoices } from '../thread/PermissionCard'

interface Waiting {
  ticket: BoardTicket
  decision: Decision
}

/** Every pending decision on the board, oldest first. */
function waitingOn(tickets: BoardTicket[]): Waiting[] {
  return tickets
    .flatMap((ticket) => ticket.pendingDecisions.map((decision) => ({ ticket, decision })))
    .sort((a, b) => a.decision.createdAt.localeCompare(b.decision.createdAt))
}

/** Every deferred decision on the board, the soonest to come back first. */
function deferredOn(tickets: BoardTicket[]): Waiting[] {
  return tickets
    .flatMap((ticket) => ticket.deferredDecisions.map((decision) => ({ ticket, decision })))
    .sort((a, b) => (a.decision.deferredUntil ?? '').localeCompare(b.decision.deferredUntil ?? ''))
}

function Controls({ decision }: { decision: Decision }): ReactElement {
  return decision.kind === 'permission' ? (
    <PermissionChoices decision={decision} via="orchestrator" />
  ) : (
    <QuestionForm decision={decision} via="orchestrator" />
  )
}

function TicketLine({ ticket, openTicket }: { ticket: BoardTicket; openTicket: (id: string) => void }): ReactElement {
  const role = ticket.lineup.find((r) => r.active)?.name
  return (
    <Text size="xs" c="dimmed">
      <Anchor component="button" type="button" size="xs" onClick={() => openTicket(ticket.id)}>
        {`#${ticket.number} ${ticket.title}`}
      </Anchor>
      {role && ` · ${role}`}
    </Text>
  )
}

async function bringBack(decision: Decision): Promise<void> {
  try {
    await asOwnChange(decision.ticketId, () => invoke('decision.bringBack', decision.id))
  } catch (err) {
    showAgentError(err, 'Could not bring this back')
  }
}

/**
 * The orchestrator's decision cards, pinned above its thread: each pending decision in the workspace with its
 * ticket, the asking role and the thread card's own answer controls, and under them a collapsed Deferred group
 * of the ones the user put off with Later…. It follows the board, so a decision answered anywhere leaves it;
 * with none pending or deferred it is not shown.
 */
export function WaitingOnYou(): ReactElement | null {
  const tickets = useMainbus((s) => s.tickets)
  const openTicket = useMainbus((s) => s.openTicket)
  const [showDeferred, setShowDeferred] = useState(false)
  const waiting = useMemo(() => waitingOn(tickets), [tickets])
  const deferred = useMemo(() => deferredOn(tickets), [tickets])
  if (waiting.length === 0 && deferred.length === 0) return null

  return (
    <Box
      px="sm"
      py="xs"
      mah="45%"
      style={{ overflowY: 'auto', flexShrink: 0, borderBottom: '1px solid var(--mantine-color-default-border)' }}
    >
      {waiting.length > 0 && (
        <Box role="region" aria-label="Waiting on you">
          <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={6}>
            Waiting on you ({waiting.length})
          </Text>
          <Stack gap="xs">
            {waiting.map(({ ticket, decision }) => (
              <Paper key={decision.id} withBorder p="sm" radius="md" data-event="waiting-decision" bg="var(--mantine-color-needs-0)">
                <Stack gap="xs">
                  <TicketLine ticket={ticket} openTicket={openTicket} />
                  <Text size="sm" fw={600} style={{ whiteSpace: 'pre-wrap' }}>
                    {decision.question}
                  </Text>
                  <Controls decision={decision} />
                </Stack>
              </Paper>
            ))}
          </Stack>
        </Box>
      )}
      {deferred.length > 0 && (
        <Box role="region" aria-label="Deferred" mt={waiting.length > 0 ? 'xs' : 0}>
          <UnstyledButton
            aria-expanded={showDeferred}
            onClick={() => setShowDeferred((o) => !o)}
            style={{ fontSize: 'var(--mantine-font-size-xs)', fontWeight: 700, textTransform: 'uppercase', color: 'var(--mantine-color-dimmed)' }}
          >
            {`${showDeferred ? '▾' : '▸'} Deferred (${deferred.length})`}
          </UnstyledButton>
          <Collapse expanded={showDeferred}>
            <Stack gap="xs" mt={6}>
              {deferred.map(({ ticket, decision }) => (
                <Paper key={decision.id} withBorder p="sm" radius="md" data-event="deferred-decision">
                  <Stack gap="xs">
                    <TicketLine ticket={ticket} openTicket={openTicket} />
                    <Text size="sm" fw={600} style={{ whiteSpace: 'pre-wrap' }}>
                      {decision.question}
                    </Text>
                    <Group justify="space-between" gap="xs">
                      <Text size="xs" c="dimmed">
                        {decision.deferredUntil ? `Until ${shortDay(decision.deferredUntil, new Date())}` : 'Deferred'}
                      </Text>
                      <Button size="compact-xs" variant="default" onClick={() => void bringBack(decision)}>
                        Bring back now
                      </Button>
                    </Group>
                    <Controls decision={decision} />
                  </Stack>
                </Paper>
              ))}
            </Stack>
          </Collapse>
        </Box>
      )}
    </Box>
  )
}
