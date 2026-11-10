import { Box, Button, Collapse, Group, Stack, Text, Title } from '@mantine/core'
import { useState, type ReactElement } from 'react'
import type { StoredEvent, ThreadRun } from '../../../shared/events'
import {
  COST_LABEL,
  formatAgentTime,
  formatCost,
  formatTokens,
  NOT_RECORDED,
  ticketUsage,
  type UsageTotals
} from '../../../shared/usageTotals'
import { modelLabel } from '../../../shared/models'

/** "Haiku 5.5, Fable 5.2": the models some usage ran on, by name and version. */
function modelsText(u: UsageTotals): string {
  return u.models.map(modelLabel).join(', ')
}

/** Tokens by kind, then turns and agent time when there were agent turns. */
function tokenText(u: UsageTotals): string {
  const tokens = `${formatTokens(u.inputTokens)} input · ${formatTokens(u.outputTokens)} output · ${formatTokens(u.cacheReadTokens)} cache read · ${formatTokens(u.cacheWriteTokens)} cache write`
  return u.turns > 0 ? `${tokens} · ${u.turns} ${u.turns === 1 ? 'turn' : 'turns'} · ${formatAgentTime(u.agentMs)}` : tokens
}

/** What some usage adds up to, with the cost labelled for what it is; "Not recorded" for none. Shared with the settings drawer. */
export function UsageTotalsView({ usage }: { usage: UsageTotals | null }): ReactElement {
  if (!usage) return <Text size="sm" c="dimmed">{NOT_RECORDED}</Text>
  return (
    <Stack gap={2}>
      <Text size="sm">{tokenText(usage)}</Text>
      {usage.models.length > 0 && (
        <Text size="xs" c="dimmed">
          {modelsText(usage)}
        </Text>
      )}
      <Text size="sm">
        {usage.costUsd === null ? 'No cost estimate' : formatCost(usage.costUsd)}
        <Text span size="xs" c="dimmed">
          {' '}
          ({COST_LABEL})
        </Text>
      </Text>
    </Stack>
  )
}

function Row({ label, usage }: { label: string; usage: UsageTotals | null }): ReactElement {
  return (
    <Group gap="xs" align="flex-start" wrap="nowrap">
      <Text size="sm" fw={500} w={110} style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <Box style={{ minWidth: 0 }}>
        {usage ? (
          <Text size="sm" c="dimmed">
            {tokenText(usage)}
            {usage.models.length > 0 ? ` · ${modelsText(usage)}` : ''}
            {usage.costUsd !== null ? ` · ${formatCost(usage.costUsd)}` : ''}
          </Text>
        ) : (
          <Text size="sm" c="dimmed">
            {NOT_RECORDED}
          </Text>
        )}
      </Box>
    </Group>
  )
}

/**
 * What the ticket's agents used: collapsed to start with, in the ticket view only (never on cards, the rail or
 * chips). Hidden before the first run.
 */
export function UsageSection({ events, runs }: { events: StoredEvent[]; runs: Record<string, ThreadRun> }): ReactElement | null {
  const [open, setOpen] = useState(false)
  if (Object.keys(runs).length === 0) return null
  const usage = ticketUsage(events, runs)
  return (
    <Box component="section" aria-label="Usage">
      <Group gap="xs" mb={6}>
        <Title order={3} size="xs" tt="uppercase" lts="0.04em" c="dimmed">
          Usage
        </Title>
        <Button
          variant="subtle"
          size="compact-xs"
          aria-expanded={open}
          aria-controls="ticket-usage"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Hide' : 'Show'}
        </Button>
      </Group>
      <Collapse expanded={open} id="ticket-usage">
        <Stack gap="sm">
          <UsageTotalsView usage={usage.total} />
          {usage.runs.map((run) => (
            <Stack key={run.ticketRunId} gap={4}>
              <Text size="xs" tt="uppercase" c="dimmed" lts="0.04em">
                Run {run.n}
              </Text>
              {run.roles.map((r) => (
                <Row key={r.role} label={r.role} usage={r.usage} />
              ))}
              {run.mainbus && <Row label="Mainbus calls" usage={run.mainbus} />}
            </Stack>
          ))}
        </Stack>
      </Collapse>
    </Box>
  )
}
