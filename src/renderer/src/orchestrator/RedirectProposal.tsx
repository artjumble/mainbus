import { Anchor, Stack, Text } from '@mantine/core'
import { DictationTextarea } from '../voice/DictationTextarea'
import type { ReactElement } from 'react'
import type { RedirectOverride, RedirectPayload, RedirectResult } from '../../../shared/proposals'
import { useMainbus } from '../store'
import type { ProposalView } from './proposalView'

/** The Override editor's state: the message. */
interface RedirectEdit {
  message: string
}

function Body({ payload }: { payload: RedirectPayload }): ReactElement {
  return (
    <Stack gap={4}>
      <Text size="sm">{`#${payload.number} ${payload.title}`}</Text>
      <Text size="sm">{`The ${payload.role} looks stuck:`}</Text>
      <Stack gap={0} aria-label="Why it looks stuck" data-stuck-evidence>
        {payload.episodeEvidence.map((line, i) => (
          <Text key={i} size="xs" c="dimmed" ff="monospace" style={{ whiteSpace: 'pre-wrap' }}>
            {line}
          </Text>
        ))}
      </Stack>
      <Text size="sm">Its turn is interrupted, and it gets this as its next message:</Text>
      <Text size="sm" fw={500} style={{ whiteSpace: 'pre-wrap' }} data-redirect-message>
        {payload.message}
      </Text>
    </Stack>
  )
}

function Editor({ value, onChange }: { value: RedirectEdit; onChange: (v: RedirectEdit) => void }): ReactElement {
  return (
    <DictationTextarea label="Message to the agent" autosize minRows={2} value={value.message} onValueChange={(message) => onChange({ message })} />
  )
}

function Receipt({ result }: { result: RedirectResult }): ReactElement {
  const openTicket = useMainbus((s) => s.openTicket)
  return (
    <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
      {`Redirected the ${result.role} on `}
      <Anchor component="button" type="button" size="sm" title={result.title} onClick={() => openTicket(result.ticketId)}>
        #{result.number}
      </Anchor>
      {`: ${result.message}`}
    </Text>
  )
}

export const redirectView: ProposalView<RedirectPayload, RedirectResult, RedirectEdit> = {
  summary: (p) => `Redirect the ${p.role} on #${p.number} ${p.title}`,
  Body,
  initialEdit: (p) => ({ message: p.message }),
  Editor,
  toOverride: (edit): RedirectOverride | null => (edit.message.trim() === '' ? null : { message: edit.message }),
  Receipt
}
