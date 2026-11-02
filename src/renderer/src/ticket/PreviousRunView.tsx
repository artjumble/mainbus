import { Anchor, Flex, Group, Text } from '@mantine/core'
import { useMemo, type ReactElement } from 'react'
import type { ThreadState } from '../thread/useThread'
import { Thread } from '../thread/Thread'

/**
 * A replaced agent's run on its own, read-only: the same thread components as the live thread, with no
 * composer, no controls and no way to answer anything. The way back returns to the live thread.
 */
export function PreviousRunView({ runId, thread, onBack }: { runId: string; thread: ThreadState; onBack: () => void }): ReactElement {
  const role = thread.runs[runId]?.role ?? 'agent'
  const events = useMemo(() => thread.events.filter((e) => e.runId === runId), [thread.events, runId])
  return (
    <Flex direction="column" flex={1} mih={0} component="section" aria-label={`Previous run of the ${role}`}>
      <Group px="md" py="xs" gap="sm" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
        <Anchor component="button" type="button" size="sm" onClick={onBack}>
          ← Back to the live thread
        </Anchor>
        <Text size="sm" c="dimmed">{`Previous run of the ${role} · read-only`}</Text>
      </Group>
      <Thread events={events} decisions={thread.decisions} runs={thread.runs} readOnly />
    </Flex>
  )
}
