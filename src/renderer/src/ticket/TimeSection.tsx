import { Box, Button, Collapse, Group, Stack, Text, Title } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import type { StoredEvent, ThreadRun } from '../../../shared/events'
import { commandLine, formatMinutes, type TicketTime } from '../../../shared/timeBreakdown'
import { invoke } from '../api'
import { TimeBar, TimeLegend } from './TimeBar'

/**
 * Where the ticket's time went: collapsed to start with, in the ticket view only (never on cards, the rail or chips).
 * Read from the engine when opened, and again while open as the thread grows. Hidden before the first run.
 */
export function TimeSection({ ticketId, events, runs }: { ticketId: string; events: StoredEvent[]; runs: Record<string, ThreadRun> }): ReactElement | null {
  const [open, setOpen] = useState(false)
  const [time, setTime] = useState<TicketTime | null>(null)
  const started = Object.keys(runs).length > 0

  useEffect(() => {
    if (!open || !started) return
    let live = true
    invoke('ticket.time', ticketId)
      .then((t) => live && setTime(t))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [open, started, ticketId, events.length])

  if (!started) return null
  return (
    <Box component="section" aria-label="Time">
      <Group gap="xs" mb={6}>
        <Title order={3} size="xs" tt="uppercase" lts="0.04em" c="dimmed">
          Time
        </Title>
        <Button variant="subtle" size="compact-xs" aria-expanded={open} aria-controls="ticket-time" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'}
        </Button>
      </Group>
      <Collapse expanded={open} id="ticket-time">
        {time === null ? (
          <Text size="sm" c="dimmed">
            Working it out…
          </Text>
        ) : (
          <Stack gap="sm">
            <Text size="sm">
              {formatMinutes(time.totalMs)} in {time.runCount} {time.runCount === 1 ? 'run' : 'runs'} and {time.roleCount} {time.roleCount === 1 ? 'role' : 'roles'}
              {time.toReviewMs !== null ? ` · ${formatMinutes(time.toReviewMs)} from the first start to Review` : ''}
            </Text>
            {time.runs.map((run) => (
              <Stack key={run.ticketRunId} gap={4}>
                <Text size="xs" tt="uppercase" c="dimmed" lts="0.04em">
                  Run {run.n} · {formatMinutes(run.totalMs)}
                </Text>
                {run.roles.map((r) => (
                  <Group key={r.role} gap="xs" wrap="nowrap" align="center">
                    <Text size="sm" fw={500} w={110} style={{ flexShrink: 0 }}>
                      {r.role}
                    </Text>
                    <Box style={{ flex: 1, minWidth: 0 }}>
                      <TimeBar label={r.role} byCategory={r.byCategory} totalMs={Math.max(...run.roles.map((x) => x.totalMs), 1)} />
                    </Box>
                    <Text size="xs" c="dimmed" w={70} ta="right" style={{ flexShrink: 0 }}>
                      {formatMinutes(r.totalMs)}
                    </Text>
                  </Group>
                ))}
              </Stack>
            ))}
            <TimeLegend byCategory={time.byCategory} />
            {time.commands.length > 0 && (
              <Stack gap={2}>
                <Text size="xs" tt="uppercase" c="dimmed" lts="0.04em">
                  Longest commands
                </Text>
                {time.commands.map((c) => (
                  <Text key={c.command} size="sm" ff="monospace">
                    {commandLine(c)}
                  </Text>
                ))}
              </Stack>
            )}
            {time.turnChecks.map((c) => (
              <Text key={c.role} size="xs" c="dimmed">
                The {c.role}'s recorded turn time ({formatMinutes(c.check.recordedMs)}) differs a lot from the log's ({formatMinutes(c.check.computedMs)}).
              </Text>
            ))}
          </Stack>
        )}
      </Collapse>
    </Box>
  )
}
