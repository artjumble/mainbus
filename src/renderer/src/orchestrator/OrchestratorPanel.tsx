import { ActionIcon, Badge, Box, Center, Flex, Group, Loader, Stack, Text, Title, UnstyledButton } from '@mantine/core'
import type { ReactElement } from 'react'
import type { Decision } from '../../../shared/domain'
import { invoke } from '../api'
import { showError } from '../notify'
import { useMainbus } from '../store'
import { Composer } from '../thread/Composer'
import { Thread } from '../thread/Thread'
import { useOrchestratorThread } from './useOrchestratorThread'

/** The aside's width open, and collapsed to its strip. */
export const PANEL_WIDTH = 380
export const STRIP_WIDTH = 44

export const EMPTY_TEXT = "Ask me to draft tickets, or about what's happening on the board."

/** The orchestrator's thread has no decision cards. */
const NO_DECISIONS: Decision[] = []

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The orchestrator, docked beside the board and the ticket view: its thread and a message box, or collapsed to a
 * strip with the needs-you count. The thread is loaded and followed even while collapsed.
 */
export function OrchestratorPanel({ open, onOpenChange }: Props): ReactElement {
  const thread = useOrchestratorThread()
  const needsYou = useMainbus((s) => s.tickets.filter((t) => t.state.column === 'needs_you').length)

  if (!open) {
    return (
      <UnstyledButton
        h="100%"
        w="100%"
        py="md"
        aria-label={`Open orchestrator (${needsYou} need you)`}
        onClick={() => onOpenChange(true)}
      >
        <Stack align="center" gap="sm" h="100%">
          <Badge color={needsYou > 0 ? 'needs' : 'gray'} variant={needsYou > 0 ? 'filled' : 'light'} circle data-needs-you>
            {needsYou}
          </Badge>
          <Text size="sm" fw={600} c="dimmed" style={{ writingMode: 'vertical-rl' }}>
            Orchestrator
          </Text>
        </Stack>
      </UnstyledButton>
    )
  }

  async function send(text: string): Promise<void> {
    try {
      await invoke('orchestrator.send', text)
    } catch (err) {
      showError(err, 'Could not send')
      throw err
    }
  }

  async function stop(): Promise<void> {
    try {
      await invoke('orchestrator.stop')
    } catch (err) {
      showError(err, 'Could not stop')
    }
  }

  const working = thread?.status === 'working'

  return (
    <Flex direction="column" h="100%" mih={0}>
      <Group
        justify="space-between"
        px="md"
        py="xs"
        wrap="nowrap"
        style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
      >
        <Title order={2} size="h5">
          Orchestrator
        </Title>
        <ActionIcon variant="subtle" color="gray" aria-label="Collapse orchestrator panel" onClick={() => onOpenChange(false)}>
          <span aria-hidden>»</span>
        </ActionIcon>
      </Group>
      {thread === null ? (
        <Center flex={1}>
          <Loader size="sm" />
        </Center>
      ) : thread.events.length === 0 ? (
        <Center flex={1} p="md">
          <Text size="sm" c="dimmed" ta="center">
            {EMPTY_TEXT}
          </Text>
        </Center>
      ) : (
        <Thread events={thread.events} decisions={NO_DECISIONS} runs={thread.runs} summariseTools />
      )}
      {working && (
        <Group gap="xs" px="md" py={4} data-working>
          <Loader size={12} type="dots" />
          <Text size="sm" c="dimmed" fs="italic">
            Working…
          </Text>
        </Group>
      )}
      <Box p="sm" pt={4}>
        <Composer placeholder="Message the orchestrator" enterSends working={working} onStop={stop} onSend={send} />
      </Box>
    </Flex>
  )
}
