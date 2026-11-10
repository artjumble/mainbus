import { Anchor, Stack, Text } from '@mantine/core'
import type { ReactElement } from 'react'
import { mergePlanSentences } from '../../../shared/merge'
import type { MergePayload, MergeResult } from '../../../shared/proposals'
import { useMainbus } from '../store'
import type { ProposalView } from './proposalView'

function Body({ payload }: { payload: MergePayload }): ReactElement {
  return (
    <Stack gap={2}>
      <Text size="sm">{`#${payload.number} ${payload.title}`}</Text>
      {mergePlanSentences(payload.plan).map((sentence) => (
        <Text key={sentence} size="sm">
          {sentence}
        </Text>
      ))}
      <Text size="sm" c="dimmed">
        {`Then moves #${payload.number} to Done: its folder is removed and its branch is kept.`}
      </Text>
    </Stack>
  )
}

function Receipt({ result }: { result: MergeResult }): ReactElement {
  const openTicket = useMainbus((s) => s.openTicket)
  return (
    <Text size="sm" c="dimmed">
      Merged{' '}
      <Anchor component="button" type="button" size="sm" title={result.title} onClick={() => openTicket(result.ticketId)}>
        #{result.number}
      </Anchor>
      {result.moved === 'moved' ? ' and moved it to Done' : result.moved === 'not_asked' ? '' : '; it is still in Review'}
    </Text>
  )
}

/** Merging has nothing to change: the card states what will happen, and only confirming does it. */
export const mergeView: ProposalView<MergePayload, MergeResult, undefined> = {
  summary: (p) => `Merge #${p.number} ${p.title}`,
  confirmLabel: () => 'Merge',
  Body,
  Receipt
}
