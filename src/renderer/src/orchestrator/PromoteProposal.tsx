import { Anchor, Stack, Text, Textarea, TextInput } from '@mantine/core'
import type { ReactElement } from 'react'
import type { PromotePayload, PromoteResult } from '../../../shared/proposals'
import { useMainbus } from '../store'
import type { ProposalView } from './proposalView'

/** The Override editor's state. */
interface PromoteEdit {
  title: string
  spec: string
}

const SPEC_SOURCES: Record<PromotePayload['specSource'], string> = {
  orchestrator: 'Spec written by the orchestrator',
  summary: 'Spec drafted from the report',
  report: "Couldn't draft a spec; it holds the report"
}

function Body({ payload }: { payload: PromotePayload }): ReactElement {
  return (
    <Stack gap={2}>
      <Text size="sm">{`From #${payload.number} ${payload.fromTitle}`}</Text>
      <Text size="sm">{`New Change ticket in Ready: ${payload.title}`}</Text>
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
        {payload.spec}
      </Text>
      <Text size="sm" c="dimmed">
        {`${SPEC_SOURCES[payload.specSource]}. The report goes with the new ticket, and #${payload.number} moves to Done.`}
      </Text>
    </Stack>
  )
}

function Editor({ value, onChange }: { value: PromoteEdit; onChange: (v: PromoteEdit) => void }): ReactElement {
  return (
    <Stack gap="xs">
      <TextInput label="Title" value={value.title} onChange={(e) => onChange({ ...value, title: e.currentTarget.value })} />
      <Textarea
        label="Spec"
        autosize
        minRows={4}
        maxRows={14}
        value={value.spec}
        onChange={(e) => onChange({ ...value, spec: e.currentTarget.value })}
      />
    </Stack>
  )
}

function Receipt({ result }: { result: PromoteResult }): ReactElement {
  const openTicket = useMainbus((s) => s.openTicket)
  return (
    <Text size="sm" c="dimmed">
      {'Promoted '}
      <Anchor component="button" type="button" size="sm" onClick={() => openTicket(result.fromTicketId)}>
        #{result.fromNumber}
      </Anchor>
      {' to '}
      <Anchor component="button" type="button" size="sm" title={result.title} onClick={() => openTicket(result.ticketId)}>
        #{result.number}
      </Anchor>
      {' in Ready'}
    </Text>
  )
}

export const promoteView: ProposalView<PromotePayload, PromoteResult, PromoteEdit> = {
  summary: (p) => `Promote #${p.number} ${p.fromTitle} to a Change ticket`,
  Body,
  initialEdit: (p) => ({ title: p.title, spec: p.spec }),
  Editor,
  toOverride: (edit) => (edit.title.trim() === '' ? null : { title: edit.title, spec: edit.spec }),
  Receipt
}
