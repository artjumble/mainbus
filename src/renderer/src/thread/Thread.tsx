import { Anchor, Badge, Box, Button, Checkbox, Code, Collapse, Group, Loader, Paper, Stack, Table, Text, Typography, UnstyledButton } from '@mantine/core'
import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Decision } from '../../../shared/domain'
import type { StoredEvent, ThreadEvent, ThreadRun } from '../../../shared/events'
import type { Proposal } from '../../../shared/proposals'
import { waitingText } from '../../../shared/waiting'
import { mergedText } from '../../../shared/merge'
import { SentImages } from '../attachments/Attachments'
import { CodeBlock } from '../code/CodeBlock'
import { CreatedTicketsReceipt } from '../orchestrator/CreatedTicketsReceipt'
import { TicketEditReceipt } from '../orchestrator/TicketEditReceipt'
import type { TicketEdit } from '../../../shared/domain'
import { ProposalCard } from '../orchestrator/ProposalCard'
import { annotate, type Annotation } from './annotate'
import { DecisionCard } from './DecisionCard'
import { PermissionCard } from './PermissionCard'
import { SetupEntry } from './SetupEntry'
import { ThinkingBlock } from './ThinkingBlock'
import classes from './Thread.module.css'
import { ROW_BADGE } from '../rowBadgeStyles'
import { MentionText } from './MentionText'
import { ToolRow } from './ToolRow'
import { summariseTools } from './toolSummary'

interface Props {
  events: StoredEvent[]
  decisions: Decision[]
  /** The agent runs the events belong to, by id: they name each event's role and ticket run. */
  runs: Record<string, ThreadRun>
  /** Collapse each group of tool rows to one summary line, such as "Read 3 files", that expands to the rows. */
  summariseTools?: boolean
  /** The orchestrator's proposals, by id: each one's card goes where it was proposed. */
  proposals?: Record<string, Proposal>
  /** The orchestrator's edits of tickets, by id: each one's receipt goes where it was made. */
  edits?: Record<string, TicketEdit>
  /** A proposal whose card to scroll into view, once per `n`; it is tried again as the card arrives. */
  reveal?: { id: string; n: number } | null
  /** Opens a run's thread on its own, read-only: the "View previous run" link of a replacement. Absent: no link. */
  onViewRun?: (runId: string) => void
  /** A past run's thread: no link to another run, and no card that asks the user anything. */
  readOnly?: boolean
}

const NO_PROPOSALS: Record<string, Proposal> = {}
const NO_EDITS: Record<string, TicketEdit> = {}

const NEAR_BOTTOM_PX = 48

/**
 * The ticket thread: agent messages and tool rows tagged with their role, thinking, dividers (handoffs between
 * roles, new runs) and inline decision cards. Follows new events while scrolled to the bottom.
 */
export function Thread({
  events,
  decisions,
  runs,
  summariseTools: summarise = false,
  proposals = NO_PROPOSALS,
  edits = NO_EDITS,
  reveal = null,
  onViewRun,
  readOnly = false
}: Props): ReactElement {
  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)

  useEffect(() => {
    const el = scroller.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [events, decisions, proposals, edits])

  // A narrower panel rewraps the content taller: stay pinned to the bottom if we were there.
  useEffect(() => {
    const content = scroller.current?.firstElementChild
    if (!content) return
    const observer = new ResizeObserver(() => {
      const el = scroller.current
      if (el && atBottom.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  const revealed = useRef(0)
  useEffect(() => {
    if (!reveal || reveal.n === revealed.current) return
    const card = scroller.current?.querySelector(`[data-proposal-id="${CSS.escape(reveal.id)}"]`)
    if (!card) return
    revealed.current = reveal.n
    card.scrollIntoView?.({ block: 'nearest' })
  }, [reveal, events, proposals])

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
  const groups = useToolGroups(events, notes, results, called, summarise)

  return (
    <Box ref={scroller} onScroll={onScroll} style={{ flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', overflowX: 'hidden' }}>
      <Stack gap="sm" p="md" style={{ minWidth: 0 }}>
        {events.map((stored, i) => {
          const { event } = stored
          // The thread holds every ticket run of the ticket, oldest first; mark where each later one starts.
          const note = notes[i]!
          const group = note.toolGroup === undefined ? undefined : groups.get(note.toolGroup)
          return (
            <Fragment key={eventKey(stored)}>
              {note.newRun && <Divider text="New run" />}
              {group ? (
                // The group's first row shows the whole group; its other rows are inside it.
                note.toolGroup === i && <ToolGroup role={note.role} items={group} />
              ) : (
                <EventRow
                  event={event}
                  role={note.role}
                  runId={stored.runId}
                  onViewRun={readOnly ? undefined : onViewRun}
                  readOnly={readOnly}
                  toolGroupStart={note.toolGroupStart}
                  handoffLabel={note.handoffLabel}
                  result={event.kind === 'tool_call' ? results.get(event.id) : undefined}
                  joined={event.kind === 'tool_result' && called.has(event.id)}
                  decision={event.kind === 'decision' ? decisionById.get(event.decisionId) : undefined}
                  proposal={event.kind === 'proposal' ? proposals[event.proposalId] : undefined}
                  edit={event.kind === 'ticket_edited' ? edits[event.editId] : undefined}
                />
              )}
            </Fragment>
          )
        })}
      </Stack>
    </Box>
  )
}

type ToolResult = { ok: boolean; summary: string }

const eventKey = (stored: StoredEvent): string => `${stored.runId}:${stored.seq}:${stored.event.kind}`

/** One tool row inside a summarised group. */
interface ToolItem {
  key: string
  name: string
  input: unknown
  result: ToolResult | undefined
}

/**
 * With `on`, the tool rows of each group by the index of the row starting it. A group whose rows have not changed
 * keeps the same array, so the memoized ToolGroup is skipped when other events arrive.
 */
function useToolGroups(
  events: StoredEvent[],
  notes: Annotation[],
  results: Map<string, ToolResult>,
  called: Set<string>,
  on: boolean
): Map<number, ToolItem[]> {
  const kept = useRef(new Map<string, ToolItem[]>())
  const groups = new Map<number, ToolItem[]>()
  if (!on) return groups
  events.forEach((stored, i) => {
    const start = notes[i]!.toolGroup
    const { event } = stored
    if (start === undefined) return
    let item: ToolItem
    if (event.kind === 'tool_call') {
      item = { key: eventKey(stored), name: event.name, input: event.input, result: results.get(event.id) }
    } else if (event.kind === 'tool_result' && !called.has(event.id)) {
      item = { key: eventKey(stored), name: 'Tool', input: undefined, result: event }
    } else {
      return
    }
    const items = groups.get(start)
    if (items) items.push(item)
    else groups.set(start, [item])
  })

  const next = new Map<string, ToolItem[]>()
  for (const [start, items] of groups) {
    const key = eventKey(events[start]!)
    const prev = kept.current.get(key)
    const same =
      prev !== undefined &&
      prev.length === items.length &&
      prev.every((p, j) => p.key === items[j]!.key && p.input === items[j]!.input && p.result === items[j]!.result)
    const group = same ? prev : items
    groups.set(start, group)
    next.set(key, group)
  }
  kept.current = next
  return groups
}

/** A group of tool rows of one run as one collapsed line, such as "Read 3 files, looked at the board". */
const ToolGroup = memo(function ToolGroup({ role, items }: { role: string; items: ToolItem[] }): ReactElement {
  const [opened, setOpened] = useState(false)
  const running = items.some((t) => t.result === undefined)
  const failed = items.some((t) => t.result && !t.result.ok)
  return (
    <Stack gap={2}>
      <RoleTag role={role} />
      <Paper withBorder radius="sm" data-event="tool_group">
        <UnstyledButton w="100%" px="xs" py={6} aria-expanded={opened} onClick={() => setOpened((o) => !o)}>
          <Group gap="xs" wrap="nowrap">
            <Text size="xs" c="dimmed" aria-hidden>
              {opened ? '▾' : '▸'}
            </Text>
            <Text size="sm" c="dimmed" truncate style={{ flex: 1, minWidth: 0 }}>
              {summariseTools(items)}
            </Text>
            {running && <Loader size={12} type="dots" />}
            {failed && (
              <Badge color="needs" variant="light" size="sm" data-failed-tag {...ROW_BADGE}>
                Failed
              </Badge>
            )}
          </Group>
        </UnstyledButton>
        <Collapse expanded={opened} keepMounted={false}>
          <Stack gap={4} p="xs" pt={0}>
            {items.map((t) => (
              <ToolRow key={t.key} name={t.name} input={t.input} result={t.result} />
            ))}
          </Stack>
        </Collapse>
      </Paper>
    </Stack>
  )
})

interface RowProps extends Lookup {
  event: ThreadEvent
}

// Memoized: with a long thread, an event that arrives must not re-render (and re-parse the markdown of) every row.
// Its props are the event, plain values and stable objects, so an unchanged row is skipped.
const EventRow = memo(function EventRow({ event, ...lookup }: RowProps): ReactElement | null {
  const row = renderEvent(event, lookup)
  return row === null ? null : <Box style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>{row}</Box>
})

interface Lookup {
  /** The name of the role whose run the event belongs to. */
  role: string
  /** The run the event belongs to. */
  runId: string
  /** For a replacement: opens the replaced run's thread. Absent: no link. */
  onViewRun: ((runId: string) => void) | undefined
  /** A past run: nothing in the row asks the user anything. */
  readOnly: boolean
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
  /** For a proposal event: the proposal it points at, once loaded. */
  proposal: Proposal | undefined
  /** For a ticket_edited event: the edit it points at, once loaded. */
  edit: TicketEdit | undefined
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
    case 'report':
      // The run's last event: the report sits where the final message would be, with the thread above it.
      return (
        <Stack gap={2} data-event="report">
          <RoleTag role={lookup.role} />
          <Paper withBorder p="sm" radius="md" component="section" aria-label="Report">
            <Text fw={600} size="sm" mb={4}>
              Report
            </Text>
            <AgentText text={event.markdown} />
          </Paper>
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
          className={classes.wrap}
          style={{ alignSelf: 'flex-end' }}
        >
          {event.images && event.images.length > 0 && (
            <Box mb={event.text === '' ? 0 : 6}>
              <SentImages images={event.images} />
            </Box>
          )}
          {event.text !== '' && <MentionText text={event.text} mentions={event.mentions} />}
        </Paper>
      )
    case 'redirected':
      // Mainbus's own entry, not the user's message: the orchestrator suggested it and the user confirmed it.
      return (
        <Paper withBorder p="sm" radius="md" maw="80%" data-event="redirected" className={classes.wrap}
          style={{ alignSelf: 'flex-end' }}>
          <Text size="xs" c="dimmed" fw={600} mb={2}>
            {`Mainbus · Redirected ${lookup.role}`}
          </Text>
          <Text size="sm">{event.text}</Text>
        </Paper>
      )
    case 'replaced':
      // Where the replacement starts: the old agent's summary, collapsed, and the way to its run. The event is the old run's last.
      return (
        <HandoffDivider
          kind="replaced"
          label={`${event.role} replaced`}
          toggle={{ show: 'Handoff from the previous run', hide: 'Handoff from the previous run' }}
          text={event.summary}
          note={event.source === 'digest' ? 'Summary from the log digest' : undefined}
        >
          {lookup.onViewRun && (
            <Anchor component="button" type="button" size="xs" onClick={() => lookup.onViewRun?.(lookup.runId)}>
              View previous run
            </Anchor>
          )}
        </HandoffDivider>
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
        <HandoffDivider
          kind="handoff"
          label={lookup.handoffLabel ?? `${lookup.role} handed off`}
          toggle={{ show: 'Show summary', hide: 'Hide summary' }}
          text={event.summary}
        />
      )
    case 'hand_back':
      return <HandoffDivider
          kind="hand_back"
          label={`${event.from} handed back to ${event.to}`}
          toggle={{ show: 'Show details', hide: 'Hide details' }}
          text={event.details}
        />
    case 'criterion_checked':
      return (
        <Text size="xs" c="dimmed" data-event="criterion_checked" className={classes.wrap}>
          {`${lookup.role} checked: ${event.text}`}
        </Text>
      )
    case 'stopped':
      return <Divider text="Stopped" />
    case 'paused':
      return <Divider text={`Paused ${lookup.role}`} />
    case 'resumed':
      return <Divider text={`Resumed ${lookup.role}`} />
    case 'queued':
      return <Divider text="Waiting for a free agent slot" />
    case 'process_exit':
      return <Divider text="The agent process ended" />
    case 'waiting':
      return (
        <Text size="xs" c="dimmed" data-event="waiting" className={classes.wrap}>
          {waitingText(lookup.role, event.reason, event.until)}
        </Text>
      )
    case 'wake':
      return (
        <Text size="xs" c="dimmed" data-event="wake" className={classes.wrap}>
          {`Mainbus: ${event.items.length} ${event.items.length === 1 ? 'thing' : 'things'} to look at`}
        </Text>
      )
    case 'notice':
      return (
        <Text size="xs" c="dimmed" data-event="notice" className={classes.wrap}>
          {event.text}
        </Text>
      )
    case 'report_file':
      // Right under the report it saved: where the file is in the repo, and the commit.
      return (
        <Text size="xs" c="dimmed" data-event="report_file">
          {'Saved as '}
          <Text span ff="monospace" size="xs">
            {event.path}
          </Text>
          {` in commit ${event.commit.slice(0, 7)} on ${event.branch}`}
        </Text>
      )
    case 'setup':
      return <SetupEntry event={event} />
    case 'pull_request':
      return (
        <Text size="xs" c="dimmed" data-event="pull_request">
          {`Pushed ${event.branch} ${event.opened ? 'and opened' : 'to'} `}
          <Anchor href={event.url} target="_blank" rel="noopener noreferrer" size="xs">
            PR #{event.number}
          </Anchor>
        </Text>
      )
    case 'merged':
      return (
        <Text size="xs" c="dimmed" data-event="merged">
          {mergedText(event)}
        </Text>
      )
    case 'error':
      return (
        <Text size="sm" c="needs.7" data-event="error" className={classes.wrap}>
          {event.message}
        </Text>
      )
    case 'decision': {
      const { decision } = lookup
      if (!decision) return null
      // A past run's thread has no controls: a question still open is only told.
      if (lookup.readOnly && (decision.status === 'pending' || decision.status === 'deferred')) {
        return (
          <Text size="xs" c="dimmed" data-event="decision" className={classes.wrap}>
            {`Asked the user: ${decision.question}`}
          </Text>
        )
      }
      return decision.kind === 'permission' ? <PermissionCard decision={decision} /> : <DecisionCard decision={decision} role={lookup.role} />
    }
    case 'proposal':
      return lookup.proposal ? (
        <ProposalCard proposal={lookup.proposal} />
      ) : (
        <Loader size="xs" type="dots" role="status" aria-label="Loading the proposal" data-event="proposal" />
      )
    case 'tickets_created':
      return <CreatedTicketsReceipt event={event} />
    case 'ticket_edited':
      return lookup.edit ? (
        <TicketEditReceipt event={event} edit={lookup.edit} />
      ) : (
        <Loader size="xs" type="dots" role="status" aria-label="Loading the edit" data-event="ticket_edited" />
      )
    default:
      // session, rate_limit, vcs_changed, turn_end, role_handoff and role_hand_back (the handoff or hand-back
      // before it shows it), stuck and stuck_failed (the Activity list tells them) and the engine-only kinds are not for the person. annotate.ts keeps the same list.
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
 * Where one role handed off to the next, handed a problem back to an earlier one, or was replaced by a fresh agent,
 * with what it said (its summary, or the problem's details) collapsed under it.
 */
function HandoffDivider({
  kind,
  label,
  toggle,
  text,
  note,
  children
}: {
  kind: 'handoff' | 'hand_back' | 'replaced'
  label: string
  /** The toggle's words when the text is hidden and when it is shown. */
  toggle: { show: string; hide: string }
  text: string
  /** Dimmed words above the text when it is open. */
  note?: string
  /** Beside the toggle. */
  children?: ReactNode
}): ReactElement {
  const replaced = kind === 'replaced'
  // A replacement's handoff is the new agent's whole start, so it opens shown.
  const [open, setOpen] = useState(replaced)
  return (
    <Stack gap={4} role="group" aria-label={label}>
      <div data-event={kind} className={`${classes.divider} ${classes.handoff}`}>
        <span className={classes.label}>{label}</span>
        {/* The way back to the old run sits in the line itself: "Implementer replaced · View previous run". */}
        {replaced && children && <span aria-hidden>·</span>}
        {replaced && children}
      </div>
      <Group gap="xs" justify="center">
        <Button variant="subtle" size="compact-xs" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {replaced ? (
            <>
              <span aria-hidden>{open ? '▾' : '▸'}</span> {toggle.show}
            </>
          ) : open ? (
            toggle.hide
          ) : (
            toggle.show
          )}
        </Button>
        {!replaced && children}
      </Group>
      {open && (
        <Paper withBorder p="sm" radius="md">
          {note && (
            <Text size="xs" c="dimmed" mb={4}>
              {note}
            </Text>
          )}
          <AgentText text={text} />
        </Paper>
      )}
    </Stack>
  )
}

/** A fenced block or inline code of agent text: a block (it has a language, or its text has a line break) is a CodeBlock. */
function AgentCode({ className, children }: { className?: string; children?: ReactNode }): ReactElement {
  const text = typeof children === 'string' ? children : ''
  const language = /language-([\w+-]+)/.exec(className ?? '')?.[1]
  if (language === undefined && !text.includes('\n')) return <Code>{children}</Code>
  return <CodeBlock code={text.replace(/\n$/, '')} language={language} label={language ?? 'text'} copyLabel="Copy code" />
}

// Module-level, so the memoized rows keep the same components.
const AGENT_TEXT_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  img: ({ alt }) => <span>{alt}</span>,
  pre: ({ children }) => <>{children}</>,
  code: ({ node: _node, className, children }) => <AgentCode className={className}>{children}</AgentCode>,
  // A wide table scrolls inside its own box, so it never widens the thread.
  table: ({ node: _node, children }) => (
    <Box className={classes.tableScroll} tabIndex={0} role="region" aria-label="Table">
      <Table withTableBorder withColumnBorders fz="sm" verticalSpacing={4} horizontalSpacing="xs" className={classes.table}>
        {children}
      </Table>
    </Box>
  ),
  thead: ({ node: _node, children }) => <Table.Thead>{children}</Table.Thead>,
  tbody: ({ node: _node, children }) => <Table.Tbody>{children}</Table.Tbody>,
  tr: ({ node: _node, children }) => <Table.Tr>{children}</Table.Tr>,
  th: ({ node: _node, children, style }) => <Table.Th style={style}>{children}</Table.Th>,
  td: ({ node: _node, children, style }) => <Table.Td style={style}>{children}</Table.Td>,
  // A task list's checkbox is read-only: the only input GFM makes.
  input: ({ node: _node, checked }) => (
    <Checkbox size="xs" checked={checked === true} disabled readOnly tabIndex={-1} aria-label={checked ? 'Done' : 'Not done'} style={{ display: 'inline-block', verticalAlign: 'middle' }} />
  )
}

const REMARK_PLUGINS = [remarkGfm]

/** Agent text is untrusted: markdown without raw HTML, no remote images, and links that open in the system browser. */
export function AgentText({ text }: { text: string }): ReactElement {
  return (
    <Typography fz="sm" className={classes.markdown}>
      <Markdown remarkPlugins={REMARK_PLUGINS} components={AGENT_TEXT_COMPONENTS}>{text}</Markdown>
    </Typography>
  )
}
