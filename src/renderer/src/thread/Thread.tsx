import { Anchor, Box, Paper, Stack, Text, Typography } from '@mantine/core'
import { Fragment, memo, useEffect, useRef, type ReactElement } from 'react'
import Markdown from 'react-markdown'
import type { Decision } from '../../../shared/domain'
import type { StoredEvent, ThreadEvent } from '../../../shared/events'
import { DecisionCard } from './DecisionCard'
import { PermissionCard } from './PermissionCard'
import { ThinkingBlock } from './ThinkingBlock'
import classes from './Thread.module.css'
import { ToolRow } from './ToolRow'

interface Props {
  events: StoredEvent[]
  decisions: Decision[]
  /** The role speaking in the agent's messages. */
  roleName?: string
}

const NEAR_BOTTOM_PX = 48

/** The ticket thread: agent messages, tool rows, thinking, dividers and inline decision cards. Follows new events while scrolled to the bottom. */
export function Thread({ events, decisions, roleName = 'Implementer' }: Props): ReactElement {
  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)

  useEffect(() => {
    const el = scroller.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [events, decisions])

  function onScroll(): void {
    const el = scroller.current
    if (el) atBottom.current = el.scrollHeight - el.clientHeight - el.scrollTop <= NEAR_BOTTOM_PX
  }

  const results = new Map<string, ToolResult>()
  const called = new Set<string>()
  for (const { event } of events) {
    if (event.kind === 'tool_result') results.set(event.id, event)
    else if (event.kind === 'tool_call') called.add(event.id)
  }
  const decisionById = new Map(decisions.map((d) => [d.id, d]))

  return (
    <Box ref={scroller} onScroll={onScroll} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <Stack gap="sm" p="md">
        {events.map((stored, i) => {
          const { event } = stored
          // The thread holds every run of the ticket, oldest first; mark where each later one starts.
          const newRun = i > 0 && events[i - 1].runId !== stored.runId
          return (
            <Fragment key={`${stored.runId}:${stored.seq}:${event.kind}`}>
              {newRun && <Divider text="New run" />}
              <EventRow
                event={event}
                roleName={roleName}
                result={event.kind === 'tool_call' ? results.get(event.id) : undefined}
                joined={event.kind === 'tool_result' && called.has(event.id)}
                decision={event.kind === 'decision' ? decisionById.get(event.decisionId) : undefined}
              />
            </Fragment>
          )
        })}
      </Stack>
    </Box>
  )
}

type ToolResult = { ok: boolean; summary: string }

interface RowProps {
  event: ThreadEvent
  roleName: string
  /** For a tool call: its result, once it has arrived. */
  result: ToolResult | undefined
  /** For a tool result: true when its call is in the thread, so the call's row already shows it. */
  joined: boolean
  /** For a decision event: the decision it points at. */
  decision: Decision | undefined
}

// Memoized: with a long thread, an event that arrives must not re-render (and re-parse the markdown of) every row.
const EventRow = memo(function EventRow({ event, roleName, result, joined, decision }: RowProps): ReactElement | null {
  const row = renderEvent(event, { roleName, result, joined, decision })
  return row === null ? null : <Box style={{ display: 'flex', flexDirection: 'column' }}>{row}</Box>
})

interface Lookup {
  roleName: string
  result: ToolResult | undefined
  joined: boolean
  decision: Decision | undefined
}

function renderEvent(event: ThreadEvent, lookup: Lookup): ReactElement | null {
  switch (event.kind) {
    case 'message':
      return (
        <Stack gap={2} data-event="message" data-partial={event.partial ? 'true' : undefined}>
          <Text size="xs" fw={700} c="dimmed" style={{ letterSpacing: '0.04em' }}>
            {lookup.roleName.toUpperCase()}
          </Text>
          <AgentText text={event.text} />
        </Stack>
      )
    case 'user_message':
      return (
        <Paper
          withBorder
          p="sm"
          radius="md"
          maw="80%"
          data-event="user_message"
          style={{ alignSelf: 'flex-end', whiteSpace: 'pre-wrap' }}
        >
          <Text size="sm">{event.text}</Text>
        </Paper>
      )
    case 'thinking':
      return <ThinkingBlock text={event.text} durationMs={event.durationMs} partial={event.partial} />
    case 'tool_call':
      return <ToolRow name={event.name} input={event.input} result={lookup.result} />
    case 'tool_result':
      // Joined to its call; a result that arrives without one is still worth showing.
      return lookup.joined ? null : <ToolRow name="Tool" input={undefined} result={event} />
    case 'nudge':
      return <Divider text={event.text} />
    case 'handoff':
      return <Divider text={event.summary} handoff />
    case 'stopped':
      return <Divider text="Stopped" />
    case 'process_exit':
      return <Divider text="The agent process ended" />
    case 'notice':
      return (
        <Text size="xs" c="dimmed" data-event="notice" style={{ whiteSpace: 'pre-wrap' }}>
          {event.text}
        </Text>
      )
    case 'pull_request':
      return (
        <Text size="xs" c="dimmed" data-event="pull_request">
          {`Pushed ${event.branch} ${event.opened ? 'and opened' : 'to'} `}
          <Anchor href={event.url} target="_blank" rel="noopener noreferrer" size="xs">
            PR #{event.number}
          </Anchor>
        </Text>
      )
    case 'error':
      return (
        <Text size="sm" c="needs.7" data-event="error" style={{ whiteSpace: 'pre-wrap' }}>
          {event.message}
        </Text>
      )
    case 'decision': {
      const { decision } = lookup
      if (!decision) return null
      return decision.kind === 'permission' ? <PermissionCard decision={decision} /> : <DecisionCard decision={decision} />
    }
    default:
      // session, rate_limit, vcs_changed, turn_end and the engine-only kinds are not for the person.
      return null
  }
}

function Divider({ text, handoff = false }: { text: string; handoff?: boolean }): ReactElement {
  return (
    <div data-event="divider" className={handoff ? `${classes.divider} ${classes.handoff}` : classes.divider}>
      <span className={classes.label}>{text}</span>
    </div>
  )
}

/** Agent text is untrusted: markdown without raw HTML, no remote images, and links that open in the system browser. */
function AgentText({ text }: { text: string }): ReactElement {
  return (
    <Typography fz="sm">
      <Markdown
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
          img: ({ alt }) => <span>{alt}</span>
        }}
      >
        {text}
      </Markdown>
    </Typography>
  )
}
