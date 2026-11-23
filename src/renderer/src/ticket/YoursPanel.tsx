import { Button, Center, Group, Modal, Stack, Text, Title } from '@mantine/core'
import { useState, type ReactElement } from 'react'
import type { BoardTicket } from '../store'
import { CriteriaChecklist } from './ContextPane'

/** In place of the thread on a ticket the user owns: no agent will start on it, its checklist, and the two ways out. */
export function YoursPanel({
  ticket,
  busy,
  onMarkDone,
  onHandToAgents
}: {
  ticket: BoardTicket
  busy: boolean
  onMarkDone: () => Promise<void>
  /** Resolves true once the ticket is handed over. */
  onHandToAgents: () => Promise<boolean>
}): ReactElement {
  const done = ticket.state.column === 'done'
  const [asking, setAsking] = useState(false)
  const [handing, setHanding] = useState(false)
  return (
    // mih 0 and its own scrolling, like NobodyWorking, so the composer line stays on screen.
    <Center flex={1} mih={0} p="md" data-yours-panel style={{ overflowY: 'auto', alignItems: 'flex-start' }}>
      <Stack gap="sm" maw={460} w="100%">
        <Title order={3} size="h4">
          This ticket is yours
        </Title>
        <Text c="dimmed">No agent will start on it. Hand it to agents when you want one to work on it.</Text>
        <Title order={4} size="sm">
          Checklist
        </Title>
        {ticket.criteria.length === 0 ? (
          <Text size="sm" c="dimmed">
            This ticket has no acceptance criteria.
          </Text>
        ) : (
          <CriteriaChecklist ticket={ticket} readOnly={done} />
        )}
        {!done && (
          <Group gap="sm">
            <Button disabled={busy} onClick={() => void onMarkDone()}>
              Mark done
            </Button>
            <Button variant="default" disabled={busy} onClick={() => setAsking(true)}>
              Hand to agents
            </Button>
          </Group>
        )}
        <Text size="xs" c="dimmed">
          Past runs on this ticket appear in the activity timeline.
        </Text>
      </Stack>
      <Modal opened={asking} onClose={() => setAsking(false)} title={`Hand #${ticket.number} to agents?`}>
        <Stack gap="md">
          <Text size="sm">
            Agents can then work on it. Start and Run settings come back, and unattended mode may start it if it is in Ready.
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" data-autofocus onClick={() => setAsking(false)} disabled={handing}>
              Cancel
            </Button>
            <Button
              loading={handing}
              onClick={() => {
                setHanding(true)
                void onHandToAgents().then((ok) => {
                  setHanding(false)
                  if (ok) setAsking(false)
                })
              }}
            >
              Hand to agents
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Center>
  )
}
