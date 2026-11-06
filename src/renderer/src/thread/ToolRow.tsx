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

/** What the tool acted on, from its input: a file, a pattern or a command; null when there is nothing to name. */
export function toolTarget(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  for (const key of ['file_path', 'notebook_path', 'path', 'pattern', 'command']) {
    const value = (input as Record<string, unknown>)[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/** One tool call and its result, collapsed to a line; expanding shows what the agent passed to the tool. */
export function ToolRow({ name, input, result }: Props): ReactElement {
  const [opened, setOpened] = useState(false)
  const target = toolTarget(input)
  const outcome = result ? result.summary : 'Running…'
  return (
    <Paper withBorder radius="sm" data-event="tool">
      <UnstyledButton w="100%" px="xs" py={6} aria-expanded={opened} onClick={() => setOpened((o) => !o)}>
        <Group gap="xs" wrap="nowrap">
          <Text size="xs" c="dimmed" aria-hidden>
            {opened ? '▾' : '▸'}
          </Text>
          {/* The tag keeps its full width beside a long target: only the target and the outcome are cut short. */}
          <Badge
            variant="light"
            color="gray"
            size="sm"
            radius="sm"
            tt="none"
            data-tool-tag
            styles={{ root: { flexShrink: 0, overflow: 'visible' }, label: { overflow: 'visible', textOverflow: 'clip' } }}
          >
            {name}
          </Badge>
          {target && (
            <Text size="sm" truncate title={target} style={{ minWidth: 0, flexShrink: 1 }} data-tool-target>
              {target}
            </Text>
          )}
          <Text size="sm" c="dimmed" truncate style={{ flex: 1, minWidth: 0 }}>
            {outcome}
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
