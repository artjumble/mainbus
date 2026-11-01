import { Anchor, Box, Button, Paper, Stack, Text, Typography } from '@mantine/core'
import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import Markdown from 'react-markdown'
import type { Decision } from '../../../shared/domain'
import type { StoredEvent, ThreadEvent, ThreadRun } from '../../../shared/events'
import { annotate } from './annotate'
import { DecisionCard } from './DecisionCard'
import { PermissionCard } from './PermissionCard'
import { ThinkingBlock } from './ThinkingBlock'
import classes from './Thread.module.css'
import { ToolRow } from './ToolRow'

interface Props {
  events: StoredEvent[]
  decisions: Decision[]
  /** The agent runs the events belong to, by id: they name each event's role and ticket run. */
  runs: Record<string, ThreadRun>
}

const NEAR_BOTTOM_PX = 48

/**
 * The ticket thread: agent messages and tool rows tagged with their role, thinking, dividers (handoffs between
 * roles, new runs) and inline decision cards. Follows new events while scrolled to the bottom.
 */
export function Thread({ events, decisions, runs }: Props): ReactElement {
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
  const notes = useMemo(() => annotate(events, runs), [events, runs])

  return (
    <Box ref={scroller} onScroll={onScroll} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <Stack gap="sm" p="md">
        {events.map((stored, i) => {
          const { event } = stored
          // The thread holds every ticket run of the ticket, oldest first; mark where each later one starts.
          const note = notes[i]!
          return (
            <Fragment key={`${stored.runId}:${stored.seq}:${event.kind}`}>
              {note.newRun && <Divider text="New run" />}
              <EventRow
                event={event}
                role={note.role}
                toolGroupStart={note.toolGroupStart}
                handoffLabel={note.handoffLabel}
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

interface RowProps extends Lookup {
  event: ThreadEvent
}

// Memoized: with a long thread, an event that arrives must not re-render (and re-parse the markdown of) every row.
// Its props are the event, plain values and stable objects, so an unchanged row is skipped.
const EventRow = memo(function EventRow({ event, ...lookup }: RowProps): ReactElement | null {
  const row = renderEvent(event, lookup)
  return row === null ? null : <Box style={{ display: 'flex', flexDirection: 'column' }}>{row}</Box>
})

interface Lookup {
  /** The name of the role whose run the event belongs to. */
  role: string
  /** For a tool row: it starts a group of tool rows, so it carries the role tag. */
  toolGroupStart: boolean
  /** For a handoff: "Planner → Implementer". */
  handoffLabel: string | undefined
  /** For a tool call: its result, once it has arrived. */
  result: ToolResult | undefined
  /** For a tool result: true when its call is in the thread, so the call's row already shows it. */
  joined: boolean
  /** For a decision event: the decision it points at. */
  decision: Decision | undefined
}

function renderEvent(event: ThreadEvent, lookup: Lookup): ReactElement | null {
  switch (event.kind) {
    case 'message':
      return (
        <Stack gap={2} data-event="message" data-partial={event.partial ? 'true' : undefined}>
          <RoleTag role={lookup.role} />
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
      return (
        <ToolGroupRow role={lookup.role} tagged={lookup.toolGroupStart}>
          <ToolRow name={event.name} input={event.input} result={lookup.result} />
        </ToolGroupRow>
      )
    case 'tool_result':
      // Joined to its call; a result that arrives without one is still worth showing.
      return lookup.joined ? null : (
        <ToolGroupRow role={lookup.role} tagged={lookup.toolGroupStart}>
          <ToolRow name="Tool" input={undefined} result={event} />
        </ToolGroupRow>
      )
    case 'nudge':
      return <Divider text={event.text} />
    case 'handoff':
      return (
        <HandoffDivider kind="handoff" label={lookup.handoffLabel ?? `${lookup.role} handed off`} what="summary" text={event.summary} />
      )
    case 'hand_back':
      return <HandoffDivider kind="hand_back" label={`${event.from} handed back to ${event.to}`} what="details" text={event.details} />
    case 'criterion_checked':
      return (
        <Text size="xs" c="dimmed" data-event="criterion_checked" style={{ whiteSpace: 'pre-wrap' }}>
          {`${lookup.role} checked: ${event.text}`}
        </Text>
      )
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
      // session, rate_limit, vcs_changed, turn_end, role_handoff and role_hand_back (the handoff or hand-back
      // before it shows it) and the engine-only kinds are not for the person. annotate.ts keeps the same list.
      return null
  }
}

/** The name of the role speaking, above its message or its group of tool rows. */
function RoleTag({ role }: { role: string }): ReactElement {
  return (
    <Text size="xs" fw={700} c="dimmed" data-role-tag style={{ letterSpacing: '0.04em' }}>
      {role.toUpperCase()}
    </Text>
  )
}

function ToolGroupRow({ role, tagged, children }: { role: string; tagged: boolean; children: ReactElement }): ReactElement {
  if (!tagged) return children
  return (
    <Stack gap={2}>
      <RoleTag role={role} />
      {children}
    </Stack>
  )
}

function Divider({ text }: { text: string }): ReactElement {
  return (
    <div data-event="divider" className={classes.divider}>
      <span className={classes.label}>{text}</span>
    </div>
  )
}

/**
 * Where one role handed off to the next, or handed a problem back to an earlier one, with what it said
 * (its summary, or the problem's details) collapsed under it.
 */
function HandoffDivider({
  kind,
  label,
  what,
  text
}: {
  kind: 'handoff' | 'hand_back'
  label: string
  what: 'summary' | 'details'
  text: string
}): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <Stack gap={4} role="group" aria-label={label}>
      <div data-event={kind} className={`${classes.divider} ${classes.handoff}`}>
        <span className={classes.label}>{label}</span>
      </div>
      <Button
        variant="subtle"
        size="compact-xs"
        style={{ alignSelf: 'center' }}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? `Hide ${what}` : `Show ${what}`}
      </Button>
      {open && (
        <Paper withBorder p="sm" radius="md">
          <AgentText text={text} />
        </Paper>
      )}
    </Stack>
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
