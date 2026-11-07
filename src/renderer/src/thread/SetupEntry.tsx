import { Button, Group, Paper, Stack, Text } from '@mantine/core'
import { useState, type ReactElement } from 'react'
import type { ThreadEvent } from '../../../shared/events'

type SetupEvent = Extract<ThreadEvent, { kind: 'setup' }>

/** "42 s", "3 min 5 s"; "under 1 s" for less. */
export function durationText(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (ms < 1000) return 'under 1 s'
  if (seconds < 60) return `${seconds} s`
  const rest = seconds % 60
  return rest === 0 ? `${Math.floor(seconds / 60)} min` : `${Math.floor(seconds / 60)} min ${rest} s`
}

function summary(e: SetupEvent): string {
  const took = durationText(e.durationMs)
  switch (e.outcome) {
    case 'succeeded':
      return `exited ${e.exitCode ?? 0} in ${took}`
    case 'failed':
      return e.exitCode === null ? `could not run (${took})` : `exited ${e.exitCode} in ${took}`
    case 'timed_out':
      return `timed out after ${took}`
    case 'stopped':
      return `stopped after ${took}`
  }
}

/**
 * Mainbus ran the workspace's setup command in the ticket's folder: one line (the command and how it ended),
 * collapsed over the end of its output and the file that has all of it. A failure is coloured like an error.
 */
export function SetupEntry({ event }: { event: SetupEvent }): ReactElement {
  const [open, setOpen] = useState(false)
  const failed = event.outcome === 'failed' || event.outcome === 'timed_out'
  const label = `${event.again ? 'Setup again' : 'Setup'} · ${event.command} ${summary(event)}`
  return (
    <Stack gap={4} role="group" aria-label={label} data-event="setup">
      <Group gap="xs" wrap="nowrap" align="baseline">
        <Text size="xs" c={failed ? 'needs.7' : 'dimmed'} style={{ wordBreak: 'break-word' }}>
          <strong>{event.again ? 'Setup again' : 'Setup'}</strong>
          {' · '}
          <span style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}>{event.command}</span>
          {` ${summary(event)}`}
        </Text>
        <Button variant="subtle" size="compact-xs" aria-expanded={open} onClick={() => setOpen((o) => !o)} style={{ flexShrink: 0 }}>
          {open ? 'Hide output' : 'Show output'}
        </Button>
      </Group>
      {open && (
        <Paper withBorder p="sm" radius="md">
          {event.tail.length === 0 ? (
            <Text size="xs" c="dimmed">
              The command printed nothing.
            </Text>
          ) : (
            <Text size="xs" ff="monospace" component="pre" m={0} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {event.tail.join('\n')}
            </Text>
          )}
          <Text size="xs" c="dimmed" mt={6} style={{ wordBreak: 'break-all' }}>
            {`The last ${event.tail.length === 1 ? 'line' : `${event.tail.length} lines`} of the output. The full log: ${event.log}`}
          </Text>
        </Paper>
      )}
    </Stack>
  )
}
