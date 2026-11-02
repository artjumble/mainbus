import { Anchor, Box, Paper, Stack, Text } from '@mantine/core'
import { useMemo, type ReactElement } from 'react'
import type { Decision } from '../../../shared/domain'
import { useMainbus, type BoardTicket } from '../store'
import { QuestionForm } from '../thread/DecisionCard'
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

/**
 * The orchestrator's decision cards, pinned above its thread: each pending decision in the workspace with its
 * ticket, the asking role and the thread card's own answer controls. It follows the board, so a decision
 * answered anywhere leaves it; with none pending it is not shown.
 */
export function WaitingOnYou(): ReactElement | null {
  const tickets = useMainbus((s) => s.tickets)
  const openTicket = useMainbus((s) => s.openTicket)
  const waiting = useMemo(() => waitingOn(tickets), [tickets])
  if (waiting.length === 0) return null

  return (
    <Box
      px="sm"
      py="xs"
      mah="45%"
      style={{ overflowY: 'auto', flexShrink: 0, borderBottom: '1px solid var(--mantine-color-default-border)' }}
      role="region"
      aria-label="Waiting on you"
    >
      <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={6}>
        Waiting on you ({waiting.length})
      </Text>
      <Stack gap="xs">
        {waiting.map(({ ticket, decision }) => {
          const role = ticket.lineup.find((r) => r.active)?.name
          return (
            <Paper key={decision.id} withBorder p="sm" radius="md" data-event="waiting-decision" bg="var(--mantine-color-needs-0)">
              <Stack gap="xs">
                <Text size="xs" c="dimmed">
                  <Anchor component="button" type="button" size="xs" onClick={() => openTicket(ticket.id)}>
                    {`#${ticket.number} ${ticket.title}`}
                  </Anchor>
                  {role && ` · ${role}`}
                </Text>
                <Text size="sm" fw={600} style={{ whiteSpace: 'pre-wrap' }}>
                  {decision.question}
                </Text>
                {decision.kind === 'permission' ? (
                  <PermissionChoices decision={decision} via="orchestrator" />
                ) : (
                  <QuestionForm decision={decision} via="orchestrator" />
                )}
              </Stack>
            </Paper>
          )
        })}
      </Stack>
    </Box>
  )
}
