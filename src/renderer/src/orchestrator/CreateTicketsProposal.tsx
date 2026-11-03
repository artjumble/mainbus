import { Anchor, Badge, Button, Checkbox, Group, Paper, Stack, Text, Textarea, TextInput } from '@mantine/core'
import { Fragment, useState, type ReactElement } from 'react'
import type {
  CreateTicketsOverride,
  CreateTicketsPayload,
  CreateTicketsResult,
  DraftColumn
} from '../../../shared/proposals'
import type { TicketKind } from '../../../shared/domain'
import { splitCriteria } from '../board/NewTicketModal'
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
}

export interface CreateTicketsEdit {
  drafts: DraftEdit[]
  column: DraftColumn
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

function splitLabels(text: string): string[] {
  return text
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label !== '')
}

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
function Editor({ value, onChange }: { value: CreateTicketsEdit; onChange: (v: CreateTicketsEdit) => void }): ReactElement {
  const [open, setOpen] = useState<number | null>(null)
  const setDraft = (i: number, patch: Partial<DraftEdit>): void =>
    onChange({ ...value, drafts: value.drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)) })
  return (
    <Stack gap="xs">
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
    </Text>
  )
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
      ...(d.kind ? { kind: d.kind } : {})
    })),
    column: p.column
  }),
  Editor,
  toOverride: (edit): CreateTicketsOverride | null => {
    const tickets = edit.drafts
      .filter((d) => d.include)
      .map((d) => ({
        title: d.title,
        spec: d.spec,
        criteria: splitCriteria(d.criteria),
        labels: splitLabels(d.labels),
        ...(d.kind ? { kind: d.kind } : {})
      }))
    return tickets.length === 0 ? null : { tickets, column: edit.column }
  },
  Receipt
}
