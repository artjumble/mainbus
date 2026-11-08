import { Anchor, Badge, Button, Checkbox, Group, Paper, Stack, Text, Textarea, TextInput } from '@mantine/core'
import { Fragment, useState, type ReactElement } from 'react'
import type {
  CreateTicketsOverride,
  CreateTicketsPayload,
  CreateTicketsResult,
  DraftColumn
} from '../../../shared/proposals'
import type { ImageRef } from '../../../shared/attachments'
import type { TicketKind } from '../../../shared/domain'
import { SentImage } from '../attachments/Attachments'
import { splitCriteria, splitLabels } from '../board/NewTicketModal'
import { useMainbus } from '../store'
import type { ProposalView } from './proposalView'

const COLUMN_NAMES: Record<DraftColumn, string> = { backlog: 'Backlog', ready: 'Ready' }

interface DraftEdit {
  include: boolean
  title: string
  spec: string
  /** One per line. */
  criteria: string
  /** Comma separated. */
  labels: string
  /** Not editable here: the edit keeps what was proposed. */
  kind?: TicketKind
  /** The run settings preset proposed, by name: not editable here. */
  preset?: string
  /** The images proposed for it, each ticked to attach it. */
  images: (ImageRef & { include: boolean })[]
  /** What blocks it, as proposed: not editable here. A `draft` is the index of an earlier draft as proposed. */
  blockedBy: (number | { draft: number })[]
}

export interface CreateTicketsEdit {
  drafts: DraftEdit[]
  column: DraftColumn
  /** The orchestrator's summary, as it will be stored; empty means left out. */
  context: string
}

/** "Blocked by #39 and ticket 1 above": a number is an existing ticket, a draft index one of the proposed tickets. */
function blockedText(blockedBy: DraftEdit['blockedBy']): string {
  const parts = blockedBy.map((b) => (typeof b === 'number' ? `#${b}` : `ticket ${b.draft + 1} above`))
  return `Blocked by ${parts.join(', ')}`
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Not shown: the card opens in `inline` mode, with the editor's rows (see `createTicketsView`). */
function Body(): ReactElement {
  return <></>
}

/** The criteria and labels of a draft, as the row's second line: "4 acceptance criteria · labels: csv, export". */
function detail(draft: DraftEdit): string {
  const criteria = splitCriteria(draft.criteria).length
  const labels = splitLabels(draft.labels)
  return [
    plural(criteria, 'acceptance criterion', 'acceptance criteria'),
    ...(labels.length > 0 ? [`labels: ${labels.join(', ')}`] : [])
  ].join(' · ')
}

/**
 * Each draft is a row: a tick to include it, its title, and Edit, which opens that draft's fields in place. The
 * drafts are ticked as proposed; the card's buttons create the ticked ones.
 */
function Editor({
  value,
  onChange,
  payload
}: {
  value: CreateTicketsEdit
  onChange: (v: CreateTicketsEdit) => void
  payload: CreateTicketsPayload
}): ReactElement {
  const [open, setOpen] = useState<number | null>(null)
  const [editingContext, setEditingContext] = useState(false)
  // Emptied while the box is open is still editing; only closed and empty is removed.
  const contextRemoved = value.context === '' && !editingContext
  const setDraft = (i: number, patch: Partial<DraftEdit>): void =>
    onChange({ ...value, drafts: value.drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)) })
  return (
    <Stack gap="xs">
      {payload.context !== undefined && (
        <Paper withBorder p="xs" radius="sm" role="region" aria-label="Summary from the orchestrator" data-context>
          <Stack gap={6}>
            <Group gap="xs" wrap="nowrap" justify="space-between" align="flex-start">
              <Stack gap={0}>
                <Text size="sm" fw={600}>
                  Summary from the orchestrator
                </Text>
                <Text size="xs" c="dimmed">
                  Added to each ticket under From an agent, not Your words
                </Text>
              </Stack>
              <Group gap={6} wrap="nowrap">
                {contextRemoved ? (
                  <Button size="compact-xs" variant="default" onClick={() => onChange({ ...value, context: payload.context ?? '' })}>
                    Restore
                  </Button>
                ) : (
                  <>
                    <Button size="compact-xs" variant="default" aria-expanded={editingContext} onClick={() => setEditingContext(!editingContext)}>
                      Edit
                    </Button>
                    <Button
                      size="compact-xs"
                      variant="default"
                      onClick={() => {
                        setEditingContext(false)
                        onChange({ ...value, context: '' })
                      }}
                    >
                      Remove
                    </Button>
                  </>
                )}
              </Group>
            </Group>
            {contextRemoved ? (
              <Text size="xs" c="dimmed">
                The summary will be left out.
              </Text>
            ) : editingContext ? (
              <Textarea
                label="Summary"
                size="xs"
                autosize
                minRows={2}
                maxRows={10}
                value={value.context}
                onChange={(e) => onChange({ ...value, context: e.currentTarget.value })}
              />
            ) : (
              <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                {value.context}
              </Text>
            )}
          </Stack>
        </Paper>
      )}
      {value.drafts.map((draft, i) => (
        <Paper key={i} withBorder p="xs" radius="sm" role="group" aria-label={`Draft ${i + 1}`} data-draft>
          <Stack gap={6}>
            <Group gap="xs" wrap="nowrap" justify="space-between" align="flex-start">
              <Checkbox
                aria-label={`Include ${draft.title || `draft ${i + 1}`}`}
                checked={draft.include}
                onChange={(e) => setDraft(i, { include: e.currentTarget.checked })}
                label={
                  <Text size="sm" fw={600} td={draft.include ? undefined : 'line-through'}>
                    {draft.title}
                    {draft.kind === 'investigate' && (
                      <Badge size="xs" variant="outline" color="gray" ml={6}>
                        Investigate
                      </Badge>
                    )}
                    {draft.preset && (
                      <Badge size="xs" variant="outline" color="gray" ml={6}>
                        Preset: {draft.preset}
                      </Badge>
                    )}
                  </Text>
                }
              />
              <Button
                size="compact-xs"
                variant="default"
                aria-expanded={open === i}
                aria-label={`Edit ${draft.title || `draft ${i + 1}`}`}
                onClick={() => setOpen(open === i ? null : i)}
              >
                Edit
              </Button>
            </Group>
            {draft.spec !== '' && (
              <Text size="xs" c="dimmed" pl={28} lineClamp={3} style={{ whiteSpace: 'pre-wrap' }}>
                {draft.spec}
              </Text>
            )}
            <Text size="xs" c="dimmed" pl={28}>
              {detail(draft)}
            </Text>
            {draft.blockedBy.length > 0 && (
              <Text size="xs" c="dimmed" pl={28} data-draft-blocked-by>
                {blockedText(draft.blockedBy)}
              </Text>
            )}
            {draft.images.length > 0 && (
              <Stack gap={4} pl={28} role="group" aria-label={`Images for ${draft.title || `draft ${i + 1}`}`} data-draft-images>
                {/* One row per image: its thumbnail, and a tick to attach it, each a full-size target. */}
                {draft.images.map((image, k) => (
                  <Group key={image.id} gap="xs" wrap="nowrap" align="flex-start">
                    <SentImage image={image} size={44} />
                    <Checkbox
                      size="xs"
                      label={
                        <Text size="xs" td={image.include ? undefined : 'line-through'} truncate="end">
                          {`Attach ${image.filename}`}
                        </Text>
                      }
                      checked={image.include}
                      onChange={(e) => {
                        const include = e.currentTarget.checked
                        setDraft(i, { images: draft.images.map((im, n) => (n === k ? { ...im, include } : im)) })
                      }}
                    />
                  </Group>
                ))}
              </Stack>
            )}
            {open === i && (
              <Stack gap={6}>
                <TextInput label="Title" size="xs" value={draft.title} onChange={(e) => setDraft(i, { title: e.currentTarget.value })} />
                <Textarea
                  label="Spec"
                  size="xs"
                  autosize
                  minRows={2}
                  maxRows={8}
                  value={draft.spec}
                  onChange={(e) => setDraft(i, { spec: e.currentTarget.value })}
                />
                <Textarea
                  label="Criteria (one per line)"
                  size="xs"
                  autosize
                  minRows={1}
                  maxRows={6}
                  value={draft.criteria}
                  onChange={(e) => setDraft(i, { criteria: e.currentTarget.value })}
                />
                <TextInput
                  label="Labels (comma separated)"
                  size="xs"
                  value={draft.labels}
                  onChange={(e) => setDraft(i, { labels: e.currentTarget.value })}
                />
              </Stack>
            )}
          </Stack>
        </Paper>
      ))}
    </Stack>
  )
}

/** "Created #21 and #22", each number opening its ticket. */
function Receipt({ result }: { result: CreateTicketsResult }): ReactElement {
  const openTicket = useMainbus((s) => s.openTicket)
  const last = result.tickets.length - 1
  return (
    <Text size="sm" c="dimmed">
      Created{' '}
      {result.tickets.map((t, i) => (
        <Fragment key={t.id}>
          {i > 0 && (i === last ? ' and ' : ', ')}
          <Anchor component="button" type="button" size="sm" title={t.title} onClick={() => openTicket(t.id)}>
            #{t.number}
          </Anchor>
        </Fragment>
      ))}
      {` in ${COLUMN_NAMES[result.column]}`}
      {result.images ? `, with ${result.images} ${result.images === 1 ? 'image' : 'images'} attached` : ''}
    </Text>
  )
}

function blockers(blockedBy: DraftEdit['blockedBy'], position: Map<number, number>): (number | { draft: number })[] {
  const kept: (number | { draft: number })[] = []
  for (const b of blockedBy) {
    if (typeof b === 'number') kept.push(b)
    else if (position.has(b.draft)) kept.push({ draft: position.get(b.draft)! })
  }
  return kept
}

export const createTicketsView: ProposalView<CreateTicketsPayload, CreateTicketsResult, CreateTicketsEdit> = {
  summary: (p) => `Create ${plural(p.tickets.length, 'ticket', 'tickets')} in ${COLUMN_NAMES[p.column]}`,
  heading: (p, workspaceName) =>
    `Proposed action · create ${plural(p.tickets.length, 'ticket', 'tickets')}${workspaceName ? ` in ${workspaceName}` : ''} → ${COLUMN_NAMES[p.column]}`,
  inline: true,
  inlineConfirmLabel: (edit) => `Create ${plural(edit.drafts.filter((d) => d.include).length, 'ticket', 'tickets')}`,
  alternatives: (edit) => {
    const other: DraftColumn = edit.column === 'backlog' ? 'ready' : 'backlog'
    return [{ label: `Put in ${COLUMN_NAMES[other]} instead`, edit: { ...edit, column: other } }]
  },
  Body,
  initialEdit: (p) => ({
    drafts: p.tickets.map((d) => ({
      include: true,
      title: d.title,
      spec: d.spec,
      criteria: d.criteria.join('\n'),
      labels: d.labels.join(', '),
      ...(d.kind ? { kind: d.kind } : {}),
      ...(d.preset ? { preset: d.preset } : {}),
      images: (d.images ?? []).map((image) => ({ ...image, include: true })),
      blockedBy: d.blocked_by ?? []
    })),
    column: p.column,
    context: p.context ?? ''
  }),
  Editor,
  toOverride: (edit): CreateTicketsOverride | null => {
    // The drafts that stay move up: a reference to one that stays follows it, one to a removed draft goes.
    const position = new Map<number, number>()
    edit.drafts.forEach((d, i) => {
      if (d.include) position.set(i, position.size)
    })
    const tickets = edit.drafts
      .filter((d) => d.include)
      .map((d) => ({
        title: d.title,
        spec: d.spec,
        criteria: splitCriteria(d.criteria),
        labels: splitLabels(d.labels),
        ...(blockers(d.blockedBy, position).length > 0 ? { blocked_by: blockers(d.blockedBy, position) } : {}),
        ...(d.kind ? { kind: d.kind } : {}),
        ...(d.preset ? { preset: d.preset } : {}),
        ...(d.images.some((image) => image.include) ? { images: d.images.filter((image) => image.include).map((image) => image.id) } : {})
      }))
    return tickets.length === 0 ? null : { tickets, column: edit.column, ...(edit.context.trim() ? { context: edit.context } : {}) }
  },
  Receipt
}
