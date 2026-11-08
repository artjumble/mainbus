import { Anchor, Badge, Box, Button, Checkbox, Code, Group, List, Stack, Text, Textarea, Timeline, Title } from '@mantine/core'
import { useState, type ReactElement, type ReactNode } from 'react'
import { ANSWERED_VIA_PHRASES, type BranchFreshness, type Criterion, type Decision } from '../../../shared/domain'
import type { StoredEvent, ThreadRun } from '../../../shared/events'
import { stuckHeadline } from '../../../shared/stuck'
import { describeEdit } from '../../../shared/ticketEdit'
import { invoke } from '../api'
import { AttachmentsSection } from '../attachments/Attachments'
import { AgentBadge } from '../board/AgentBadge'
import { BlockedByPicker } from './BlockedByPicker'
import { showError } from '../notify'
import { useMainbus, type BoardTicket } from '../store'
import { PERMISSION_ANSWERS } from '../thread/PermissionCard'
import { AgentText } from '../thread/Thread'

interface Props {
  ticket: BoardTicket
  events: StoredEvent[]
  decisions: Decision[]
  /** The runs the events belong to, by id: they name the role of each. */
  runs?: Record<string, ThreadRun>
  /** Opens a run's thread on its own, read-only; the timeline's "View run" and "View previous run" links use it. */
  onViewRun?: (runId: string) => void
}

/** The left side of the ticket: what an agent filed and what the person asked for, the spec, criteria, images, labels and what has happened so far. */
export function ContextPane({ ticket, events, decisions, runs, onViewRun }: Props): ReactElement {
  return (
    <Stack gap="lg" p="md">
      <Promotion ticket={ticket} />
      <YourWords ticket={ticket} />
      <Spec ticket={ticket} />
      <InvestigationReport ticket={ticket} />
      <Criteria ticket={ticket} />
      <Section title="Attachments">
        <AttachmentsSection ticket={ticket} />
      </Section>
      <BlockedBy ticket={ticket} />
      <Labels labels={ticket.labels} />
      <Branch ticket={ticket} />
      <Activity ticket={ticket} events={events} decisions={decisions} runs={runs} onViewRun={onViewRun} />
    </Stack>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <Box component="section" aria-label={title}>
      <Title order={3} size="xs" tt="uppercase" lts="0.04em" c="dimmed" mb={6}>
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

/** The link between an Investigate ticket and the Change ticket promoted from its report, from either side. */
function Promotion({ ticket }: { ticket: BoardTicket }): ReactElement | null {
  const tickets = useMainbus((s) => s.tickets)
  const openTicket = useMainbus((s) => s.openTicket)
  const from = ticket.promotedFrom === null ? undefined : tickets.find((t) => t.id === ticket.promotedFrom)
  const to = tickets.find((t) => t.promotedFrom === ticket.id)
  const link = (label: string, other: BoardTicket) => (
    <Text size="sm">
      {`${label} `}
      <Anchor component="button" type="button" size="sm" onClick={() => openTicket(other.id)}>
        {`#${other.number} ${other.title}`}
      </Anchor>
    </Text>
  )
  if (!from && !to) return null
  return (
    <Section title="Promotion">
      <Stack gap={2}>
        {from && link('Promoted from', from)}
        {to && link('Promoted to', to)}
      </Stack>
    </Section>
  )
}

/** The report the Change ticket was promoted from; the agents get it too. */
function InvestigationReport({ ticket }: { ticket: BoardTicket }): ReactElement | null {
  if (ticket.kind !== 'change' || !ticket.report) return null
  return (
    <Section title="Investigation report">
      <AgentText text={ticket.report} />
    </Section>
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
    <Section title="Acceptance criteria">
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

/** The tickets that should be Done first; changed at any time, and saved as soon as it changes. */
function BlockedBy({ ticket }: { ticket: BoardTicket }): ReactElement {
  const saved = ticket.blockedBy.map((b) => b.id)
  // What was picked while saving; null when the saved list shows.
  const [picked, setPicked] = useState<string[] | null>(null)

  async function change(ids: string[]): Promise<void> {
    setPicked(ids)
    try {
      await invoke('ticket.setBlockedBy', ticket.id, ids)
    } catch (err) {
      showError(err, 'Could not change what blocks the ticket')
    } finally {
      setPicked(null)
    }
  }

  return (
    <Section title="Blocked by">
      <BlockedByPicker ticketId={ticket.id} value={picked ?? saved} onChange={(ids) => void change(ids)} />
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
function Branch({ ticket }: { ticket: BoardTicket }): ReactElement | null {
  const { branch, freshness } = ticket
  if (branch === null) return null
  return (
    <Section title="Branch">
      <Code>{branch}</Code>
      {ticket.manualColumn !== 'done' && freshness && <Freshness freshness={freshness} />}
    </Section>
  )
}

/** How far the branch is behind the newest base, and the files a merge would conflict in. */
function Freshness({ freshness }: { freshness: BranchFreshness }): ReactElement {
  return (
    <Stack gap={4} mt={6} data-freshness-details>
      <Text size="sm">
        {freshness.behind === 0
          ? `Up to date with ${freshness.base}.`
          : `${freshness.behind} commit${freshness.behind === 1 ? '' : 's'} behind ${freshness.base}.`}
      </Text>
      {freshness.conflicts.length > 0 && (
        <>
          <Text size="sm">Merging it conflicts in:</Text>
          <List size="sm" spacing={2} listStyleType="disc">
            {freshness.conflicts.map((file) => (
              <List.Item key={file}>
                <Code>{file}</Code>
              </List.Item>
            ))}
          </List>
        </>
      )}
      {freshness.fetchError !== null && (
        <Text size="xs" c="dimmed">
          {`Couldn't fetch the newest ${freshness.baseBranch}: ${freshness.fetchError}`}
        </Text>
      )}
    </Stack>
  )
}

interface Entry {
  at: string
  title: string
  detail?: string
  /** Where the entry leads: the run or the proposal it is about. */
  links?: { label: string; onClick: () => void }[]
}

const MAX_DETAIL = 160

function clip(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text
}

/** The time of day, with the date first when it isn't today: "14:05", "Nov 2, 14:05". */
export function entryTime(at: string, now = new Date()): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

interface Context {
  ticket: BoardTicket
  workspaceName: string
  runs: Record<string, ThreadRun>
}

/**
 * What happened to the ticket, oldest first: who created it, runs starting, handoffs, replacements, stops and the
 * person's answers.
 */
function activityEntries(events: StoredEvent[], decisions: Decision[], go: Go, { ticket, workspaceName, runs }: Context): Entry[] {
  const first = ticket.intent[0]
  const created = first?.source
    ? `Filed by ${first.source.agent}`
    : first?.via === 'orchestrator'
      ? 'Created by the orchestrator at your request'
      : 'Created by you'
  const entries: Entry[] = [{ at: ticket.createdAt, title: created }]
  // The ticket runs seen so far: each role's run is its own run, but only the first of a ticket run is "started".
  const seen = new Set<string>()
  // The role a replacement is waiting to start, and what each run was last stuck on.
  let replacing: string | null = null
  const stuckOn = new Map<string, string>()
  for (const { runId, seq, at, event } of events) {
    if (seq === 0) continue
    const role = runs[runId]?.role
    const startedRun = runs[runId]?.ticketRunId ?? runId
    if (replacing && !seen.has(runId)) {
      seen.add(runId)
      entries.push({ at, title: `New ${replacing} started from the plan` })
      replacing = null
    } else if (!seen.has(startedRun)) {
      entries.push({ at, title: `Started with the ${workspaceName} lineup` })
    }
    seen.add(runId)
    seen.add(startedRun)
    if (event.kind === 'handoff') {
      const by = role ? `${role} handed off` : 'Handed off'
      entries.push({
        at,
        title: event.skipped ? 'Skipped (summary generated by Mainbus)' : event.to ? `${by} to the ${event.to}` : by,
        detail: clip(event.summary)
      })
    }
    else if (event.kind === 'report') entries.push({ at, title: 'Submitted a report', detail: clip(event.markdown) })
    else if (event.kind === 'stopped') entries.push({ at, title: 'Stopped' })
    else if (event.kind === 'stuck') {
      const headline = stuckHeadline(event.rule, event.count)
      stuckOn.set(runId, headline)
      const title =
        event.change === 'opened'
          ? `${event.role} looks stuck: ${headline} (detected by Mainbus)`
          : event.change === 'escalated'
            ? `${event.role} still looks stuck: ${headline}, needs a closer look (detected by Mainbus)`
            : `${event.role} still looks stuck after the redirect: ${headline} (detected by Mainbus)`
      entries.push({ at, title, links: [go.run('View run', runId)] })
    } else if (event.kind === 'redirected') {
      entries.push({
        at,
        title: `Redirected ${event.role}: ${clip(event.text)} (suggested by the orchestrator, confirmed by you)`,
        ...(event.proposalId ? { links: [go.proposal(event.proposalId)] } : {})
      })
    } else if (event.kind === 'replaced') {
      const by =
        event.suggestedBy === 'orchestrator'
          ? 'Suggested by orchestrator, confirmed by you'
          : event.suggestedBy === 'user'
            ? 'Suggested by you with Replace…, confirmed by you'
            : 'Confirmed by you'
      replacing = event.role
      const headline = stuckOn.get(runId)
      entries.push({
        at,
        title: `${event.role} replaced${headline ? `: ${headline}` : ''}`,
        detail: by,
        links: [go.run('View previous run', runId), ...(event.proposalId ? [go.proposal(event.proposalId)] : [])]
      })
    } else if (event.kind === 'stuck_failed') {
      const times = event.replacements === 1 ? 'once' : `${event.replacements} times`
      entries.push({ at, title: `${event.role} marked Failed: stuck again after being replaced ${times} (by Mainbus)`, links: [go.run('View run', runId)] })
    }
  }
  for (const edit of ticket.edits) {
    const what = describeEdit(edit.fields, edit.userWords, 'your words')
    entries.push({ at: edit.at, title: `Edited by the orchestrator at your request: ${what}` })
    if (edit.undoneAt !== null) entries.push({ at: edit.undoneAt, title: 'Undone', detail: `The orchestrator's edit: ${what}` })
  }
  for (const note of ticket.dependencyNotes) {
    const numbers = note.blockers.map((b) => `#${b.number}`).join(', ')
    entries.push(
      note.kind === 'unblocked'
        ? { at: note.at, title: `Unblocked: ${numbers} ${note.blockers.length === 1 ? 'is' : 'are'} Done` }
        : { at: note.at, title: `Started while blocked by ${numbers} (${note.via === 'proposal' ? 'you confirmed the start anyway' : 'you chose to start anyway'})` }
    )
  }
  for (const d of decisions) {
    if (d.status !== 'answered' || !d.answeredAt || !d.answer) continue
    if (d.answer.kind === 'message') {
      entries.push({ at: d.answeredAt, title: `Decision: ${clip(d.question)} → answered in a message (you)`, detail: d.answer.text })
      continue
    }
    const answer =
      d.answer.kind === 'option'
        ? (d.options[d.answer.index] ?? `option ${d.answer.index + 1}`)
        : PERMISSION_ANSWERS[d.answer.choice]
    const from = d.answeredVia ? `you, ${ANSWERED_VIA_PHRASES[d.answeredVia]}` : 'you'
    entries.push({
      at: d.answeredAt,
      title: `Decision: ${clip(d.question)} → ${answer} (${from})`,
      ...(d.answer.note ? { detail: d.answer.note } : {})
    })
  }
  // Array sort is stable, so entries with the same time keep the order above.
  return entries.sort((a, b) => a.at.localeCompare(b.at))
}

/** Builds the timeline's links: to a run's thread, and to a proposal's card in the orchestrator panel. */
interface Go {
  run(label: string, runId: string): { label: string; onClick: () => void }
  proposal(id: string): { label: string; onClick: () => void }
}

const NO_RUNS: Record<string, ThreadRun> = {}

function Activity({ ticket, events, decisions, runs = NO_RUNS, onViewRun }: Props): ReactElement {
  const revealProposal = useMainbus((s) => s.revealProposal)
  const workspaceName = useMainbus((s) => s.workspace?.name ?? 'workspace')
  const go: Go = {
    run: (label, runId) => ({ label, onClick: () => onViewRun?.(runId) }),
    proposal: (id) => ({ label: 'View proposal', onClick: () => revealProposal(id) })
  }
  const entries = activityEntries(events, decisions, go, { ticket, workspaceName, runs })
  return (
    <Section title="Activity">
      <Timeline role="list" bulletSize={12} lineWidth={2} active={entries.length - 1}>
        {entries.map((entry, i) => (
          <Timeline.Item key={i} role="listitem" title={entry.title}>
            {entry.detail && (
              <Text size="sm" c="dimmed">
                {entry.detail}
              </Text>
            )}
            <Text size="xs" c="dimmed" component="time" dateTime={entry.at}>
              {entryTime(entry.at)}
            </Text>
            {entry.links && (
              <Group gap="sm">
                {entry.links.map((link) => (
                  <Anchor key={link.label} component="button" type="button" size="xs" onClick={link.onClick}>
                    {link.label}
                  </Anchor>
                ))}
              </Group>
            )}
          </Timeline.Item>
        ))}
      </Timeline>
    </Section>
  )
}
