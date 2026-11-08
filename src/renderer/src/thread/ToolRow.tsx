import { Badge, Collapse, Group, Paper, Stack, Text, UnstyledButton } from '@mantine/core'
import { useState, type ReactElement } from 'react'
import { CodeBlock } from '../code/CodeBlock'
import { ROW_BADGE } from '../rowBadgeStyles'

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

/** A shell tool's command, and the rest of its input (null when nothing else is in it); other tools show their whole input. */
function splitInput(name: string, input: unknown): { command: string | null; rest: unknown } {
  if (name !== 'Bash' && name !== 'PowerShell') return { command: null, rest: input }
  if (typeof input !== 'object' || input === null) return { command: null, rest: input }
  const { command, ...others } = input as Record<string, unknown>
  if (typeof command !== 'string') return { command: null, rest: input }
  return { command, rest: Object.keys(others).length > 0 ? others : null }
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
  const { command, rest } = splitInput(name, input)
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
            data-tool-tag
            {...ROW_BADGE}
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
            <Badge color="needs" variant="light" size="sm" data-failed-tag {...ROW_BADGE}>
              Failed
            </Badge>
          )}
        </Group>
      </UnstyledButton>
      <Collapse expanded={opened} keepMounted={false}>
        <Stack gap="xs" m="xs" mt={0}>
          {command !== null && <CodeBlock code={command} language={name === 'PowerShell' ? 'powershell' : 'bash'} copyLabel="Copy command" />}
          {rest !== null && <CodeBlock code={showInput(rest)} language="json" copyLabel="Copy input" />}
        </Stack>
      </Collapse>
    </Paper>
  )
}
