import { Box, Collapse, Group, Loader, Text, UnstyledButton } from '@mantine/core'
import { useState, type ReactElement } from 'react'

interface Props {
  text: string | null
  durationMs?: number
  partial?: boolean
}

/**
 * The agent's reasoning. The subscription returns no reasoning text, so normally this is a stub, "Thought for 4s",
 * or a live "Thinking…" while it happens. If text ever arrives it is a collapsible block.
 */
export function ThinkingBlock({ text, durationMs, partial }: Props): ReactElement {
  const [opened, setOpened] = useState(false)

  if (partial) {
    return (
      <Group gap="xs" data-event="thinking">
        <Loader size={12} type="dots" aria-hidden />
        <Text size="sm" c="dimmed" fs="italic">
          Thinking…
        </Text>
      </Group>
    )
  }

  if (text === null) {
    const label = durationMs === undefined ? 'Thought' : `Thought for ${Math.max(1, Math.round(durationMs / 1000))}s`
    return (
      <Text size="sm" c="dimmed" fs="italic" data-event="thinking">
        {label}
      </Text>
    )
  }

  return (
    <Box data-event="thinking">
      <UnstyledButton aria-expanded={opened} onClick={() => setOpened((o) => !o)}>
        <Text size="sm" c="dimmed" fs="italic">
          <span aria-hidden>{opened ? '▾' : '▸'}</span> Thinking
        </Text>
      </UnstyledButton>
      <Collapse expanded={opened} keepMounted={false}>
        <Text size="sm" c="dimmed" mt={4} style={{ whiteSpace: 'pre-wrap' }}>
          {text}
        </Text>
      </Collapse>
    </Box>
  )
}
