import { Badge, Code, Collapse, Group, Paper, Text, UnstyledButton } from '@mantine/core'
import { useState, type ReactElement } from 'react'

interface Props {
  name: string
  input: unknown
  /** Absent while the tool is still running. */
  result?: { ok: boolean; summary: string }
}

const MAX_INPUT_CHARS = 4000

function showInput(input: unknown): string {
  let text: string
  try {
    text = JSON.stringify(input, null, 2) ?? String(input)
  } catch {
    text = String(input)
  }
  return text.length > MAX_INPUT_CHARS ? `${text.slice(0, MAX_INPUT_CHARS)}\n…` : text
}

/** One tool call and its result, collapsed to a line; expanding shows what the agent passed to the tool. */
export function ToolRow({ name, input, result }: Props): ReactElement {
  const [opened, setOpened] = useState(false)
  return (
    <Paper withBorder radius="sm" data-event="tool">
      <UnstyledButton w="100%" px="xs" py={6} aria-expanded={opened} onClick={() => setOpened((o) => !o)}>
        <Group gap="xs" wrap="nowrap">
          <Text size="xs" c="dimmed">
            {opened ? '▾' : '▸'}
          </Text>
          <Code>{name}</Code>
          <Text size="sm" c="dimmed" truncate style={{ flex: 1, minWidth: 0 }}>
            {result ? result.summary : 'Running…'}
          </Text>
          {result && !result.ok && (
            <Badge color="needs" variant="light" size="sm">
              Failed
            </Badge>
          )}
        </Group>
      </UnstyledButton>
      <Collapse expanded={opened} keepMounted={false}>
        <Code block m="xs" mt={0}>
          {showInput(input)}
        </Code>
      </Collapse>
    </Paper>
  )
}
