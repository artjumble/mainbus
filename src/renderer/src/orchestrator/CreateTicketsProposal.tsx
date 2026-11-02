import { Anchor, Badge, Checkbox, Group, Paper, SegmentedControl, Stack, Text, Textarea, TextInput } from '@mantine/core'
import { Fragment, type ReactElement } from 'react'
import type {
  CreateTicketsOverride,
  CreateTicketsPayload,
  CreateTicketsResult,
  DraftColumn
} from '../../../shared/proposals'
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

/** The drafts as proposed: each title, its spec clipped, its criteria and labels. */
function Body({ payload }: { payload: CreateTicketsPayload }): ReactElement {
  return (
    <Stack gap="xs">
      {payload.tickets.map((draft, i) => (
        <Paper key={i} withBorder p="xs" radius="sm" data-draft>
          <Stack gap={4}>
            <Text size="sm" fw={600}>
              {draft.title}
            </Text>
            {draft.spec !== '' && (
              <Text size="xs" c="dimmed" lineClamp={4} style={{ whiteSpace: 'pre-wrap' }}>
                {draft.spec}
              </Text>
            )}
            {(draft.criteria.length > 0 || draft.labels.length > 0) && (
              <Group gap={4}>
                {draft.criteria.length > 0 && (
                  <Text size="xs" c="dimmed">
                    {plural(draft.criteria.length, 'criterion', 'criteria')}
                  </Text>
                )}
                {draft.labels.map((label) => (
                  <Badge key={label} size="xs" variant="light" color="gray">
                    {label}
                  </Badge>
                ))}
              </Group>
            )}
          </Stack>
        </Paper>
      ))}
    </Stack>
  )
}

/** Override: every draft's fields editable, a box to leave each one out, and the column. */
function Editor({ value, onChange }: { value: CreateTicketsEdit; onChange: (v: CreateTicketsEdit) => void }): ReactElement {
  const setDraft = (i: number, patch: Partial<DraftEdit>): void =>
    onChange({ ...value, drafts: value.drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)) })
  return (
    <Stack gap="sm">
      {value.drafts.map((draft, i) => (
        <Paper key={i} withBorder p="xs" radius="sm" role="group" aria-label={`Draft ${i + 1}`}>
          <Stack gap={6}>
            <Checkbox
              label="Include"
              checked={draft.include}
              onChange={(e) => setDraft(i, { include: e.currentTarget.checked })}
            />
            <TextInput
              label="Title"
              size="xs"
              disabled={!draft.include}
              value={draft.title}
              onChange={(e) => setDraft(i, { title: e.currentTarget.value })}
            />
            <Textarea
              label="Spec"
              size="xs"
              autosize
              minRows={2}
              maxRows={8}
              disabled={!draft.include}
              value={draft.spec}
              onChange={(e) => setDraft(i, { spec: e.currentTarget.value })}
            />
            <Textarea
              label="Criteria (one per line)"
              size="xs"
              autosize
              minRows={1}
              maxRows={6}
              disabled={!draft.include}
              value={draft.criteria}
              onChange={(e) => setDraft(i, { criteria: e.currentTarget.value })}
            />
            <TextInput
              label="Labels (comma separated)"
              size="xs"
              disabled={!draft.include}
              value={draft.labels}
              onChange={(e) => setDraft(i, { labels: e.currentTarget.value })}
            />
          </Stack>
        </Paper>
      ))}
      <SegmentedControl
        size="xs"
        aria-label="Column"
        value={value.column}
        onChange={(column) => onChange({ ...value, column: column as DraftColumn })}
        data={[
          { value: 'backlog', label: 'Backlog' },
          { value: 'ready', label: 'Ready' }
        ]}
      />
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
  Body,
  initialEdit: (p) => ({
    drafts: p.tickets.map((d) => ({
      include: true,
      title: d.title,
      spec: d.spec,
      criteria: d.criteria.join('\n'),
      labels: d.labels.join(', ')
    })),
    column: p.column
  }),
  Editor,
  toOverride: (edit): CreateTicketsOverride | null => {
    const tickets = edit.drafts
      .filter((d) => d.include)
      .map((d) => ({ title: d.title, spec: d.spec, criteria: splitCriteria(d.criteria), labels: splitLabels(d.labels) }))
    return tickets.length === 0 ? null : { tickets, column: edit.column }
  },
  Receipt
}
