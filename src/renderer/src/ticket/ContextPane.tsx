import { Badge, Box, Button, Checkbox, Code, Group, Stack, Text, Textarea, Timeline, Title } from '@mantine/core'
import { useState, type ReactElement, type ReactNode } from 'react'
import type { Criterion, Decision } from '../../../shared/domain'
import type { StoredEvent } from '../../../shared/events'
import { invoke } from '../api'
import { AgentBadge } from '../board/AgentBadge'
import { showError } from '../notify'
import type { BoardTicket } from '../store'
import { PERMISSION_ANSWERS } from '../thread/PermissionCard'

interface Props {
  ticket: BoardTicket
  events: StoredEvent[]
  decisions: Decision[]
}

/** The left side of the ticket: what an agent filed and what the person asked for, the spec, criteria, labels and what has happened so far. */
export function ContextPane({ ticket, events, decisions }: Props): ReactElement {
  return (
    <Stack gap="lg" p="md">
      <YourWords ticket={ticket} />
      <Spec ticket={ticket} />
      <Criteria ticket={ticket} />
      <Labels labels={ticket.labels} />
      <Branch branch={ticket.branch} />
      <Activity events={events} decisions={decisions} />
    </Stack>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <Box component="section" aria-label={title}>
      <Title order={3} size="h5" mb={6}>
        {title}
      </Title>
      {children}
    </Box>
  )
}

function YourWords({ ticket }: { ticket: BoardTicket }): ReactElement {
  const [adding, setAdding] = useState('')
  const [saving, setSaving] = useState(false)

  async function add(): Promise<void> {
    if (adding.trim() === '' || saving) return
    setSaving(true)
    try {
      await invoke('ticket.appendIntent', ticket.id, adding)
      setAdding('')
    } catch (err) {
      showError(err, 'Could not add to your words')
    } finally {
      setSaving(false)
    }
  }

  // Index in the whole intent: the first entry is the original, later ones say when they were added.
  const entries = ticket.intent.map((entry, i) => ({ entry, i }))
  const yours = entries.filter(({ entry }) => !entry.source)
  const agents = entries.filter(({ entry }) => entry.source)

  return (
    <>
      {agents.length > 0 && (
        <Section title="From an agent">
          <Stack gap="xs">
            {agents.map(({ entry, i }) => (
              <Box key={`${entry.at}:${i}`}>
                <Group gap="xs" mb={4}>
                  {entry.source && <AgentBadge source={entry.source} />}
                  {i > 0 && <Added at={entry.at} />}
                </Group>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                  {entry.text}
                </Text>
              </Box>
            ))}
          </Stack>
        </Section>
      )}
      <Section title="Your words">
        <Stack gap="xs">
          {yours.length === 0 && (
            <Text size="sm" c="dimmed">
              You haven't added your own words yet.
            </Text>
          )}
          {yours.map(({ entry, i }) => (
            <Box key={`${entry.at}:${i}`}>
              {i > 0 && <Added at={entry.at} />}
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {entry.text}
              </Text>
            </Box>
          ))}
          <Textarea
            aria-label="Add to your words"
            placeholder="Add to your words"
            autosize
            minRows={2}
            maxRows={6}
            value={adding}
            onChange={(e) => setAdding(e.currentTarget.value)}
          />
          <Button w="fit-content" size="compact-sm" disabled={adding.trim() === ''} loading={saving} onClick={() => void add()}>
            Add
          </Button>
        </Stack>
      </Section>
    </>
  )
}

function Added({ at }: { at: string }): ReactElement {
  return (
    <Text size="xs" c="dimmed" component="time" dateTime={at}>
      {new Date(at).toLocaleString()}
    </Text>
  )
}

function Spec({ ticket }: { ticket: BoardTicket }): ReactElement {
  // null means "no edit in progress": the box follows the ticket.
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const dirty = draft !== null && draft !== ticket.spec

  async function save(): Promise<void> {
    if (draft === null || saving) return
    setSaving(true)
    try {
      await invoke('ticket.update', ticket.id, { spec: draft })
      setDraft(null)
    } catch (err) {
      showError(err, 'Could not save the spec')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Stack gap="xs">
      <Textarea
        label="Spec"
        autosize
        minRows={3}
        maxRows={14}
        value={draft ?? ticket.spec}
        onChange={(e) => setDraft(e.currentTarget.value)}
      />
      <Button w="fit-content" size="compact-sm" disabled={!dirty} loading={saving} onClick={() => void save()}>
        Save spec
      </Button>
    </Stack>
  )
}

function Criteria({ ticket }: { ticket: BoardTicket }): ReactElement | null {
  if (ticket.criteria.length === 0) return null

  async function toggle(position: number, checked: boolean): Promise<void> {
    const criteria: Criterion[] = ticket.criteria.map((c) => (c.position === position ? { ...c, checked } : c))
    try {
      await invoke('ticket.update', ticket.id, { criteria })
    } catch (err) {
      showError(err, 'Could not update the criteria')
    }
  }

  return (
    <Section title="Criteria">
      <Stack gap={6}>
        {ticket.criteria.map((c) => (
          <Checkbox
            key={c.position}
            label={c.text}
            checked={c.checked}
            onChange={(e) => void toggle(c.position, e.currentTarget.checked)}
          />
        ))}
      </Stack>
    </Section>
  )
}

function Labels({ labels }: { labels: string[] }): ReactElement | null {
  if (labels.length === 0) return null
  return (
    <Section title="Labels">
      <Group gap="xs">
        {labels.map((label) => (
          <Badge key={label} variant="light" color="gray" radius="sm">
            {label}
          </Badge>
        ))}
      </Group>
    </Section>
  )
}

/** The ticket's own branch, set once a run has created it: the branch to review and merge. */
function Branch({ branch }: { branch: string | null }): ReactElement | null {
  if (branch === null) return null
  return (
    <Section title="Branch">
      <Code>{branch}</Code>
    </Section>
  )
}

interface Entry {
  at: string
  title: string
  detail?: string
}

const MAX_DETAIL = 160

function clip(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text
}

/** What happened to the ticket, oldest first: runs starting, handoffs, stops and the person's answers. */
function activityEntries(events: StoredEvent[], decisions: Decision[]): Entry[] {
  const entries: Entry[] = []
  const seen = new Set<string>()
  for (const { runId, seq, at, event } of events) {
    if (seq === 0) continue
    if (!seen.has(runId)) {
      seen.add(runId)
      entries.push({ at, title: 'Run started' })
    }
    if (event.kind === 'handoff') entries.push({ at, title: 'Handed off', detail: clip(event.summary) })
    else if (event.kind === 'stopped') entries.push({ at, title: 'Stopped' })
  }
  for (const d of decisions) {
    if (d.status !== 'answered' || !d.answeredAt || !d.answer) continue
    const answer =
      d.answer.kind === 'option'
        ? (d.options[d.answer.index] ?? `option ${d.answer.index + 1}`)
        : PERMISSION_ANSWERS[d.answer.choice]
    entries.push({ at: d.answeredAt, title: `Answered: ${clip(d.question)}`, detail: answer })
  }
  // Array sort is stable, so entries with the same time keep the order above.
  return entries.sort((a, b) => a.at.localeCompare(b.at))
}

function Activity({ events, decisions }: { events: StoredEvent[]; decisions: Decision[] }): ReactElement {
  const entries = activityEntries(events, decisions)
  return (
    <Section title="Activity">
      {entries.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nothing has happened yet.
        </Text>
      ) : (
        <Timeline role="list" bulletSize={12} lineWidth={2} active={entries.length - 1}>
          {entries.map((entry, i) => (
            <Timeline.Item key={i} role="listitem" title={entry.title}>
              {entry.detail && (
                <Text size="sm" c="dimmed">
                  {entry.detail}
                </Text>
              )}
              <Text size="xs" c="dimmed" component="time" dateTime={entry.at}>
                {new Date(entry.at).toLocaleString()}
              </Text>
            </Timeline.Item>
          ))}
        </Timeline>
      )}
    </Section>
  )
}
