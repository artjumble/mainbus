import { Anchor, Stack, Text } from '@mantine/core'
import type { ReactElement } from 'react'
import type { UpdateFromMainPayload, UpdateFromMainResult } from '../../../shared/proposals'
import { useMainbus } from '../store'
import type { ProposalView } from './proposalView'

function Body({ payload }: { payload: UpdateFromMainPayload }): ReactElement {
  const commits = `${payload.behind} commit${payload.behind === 1 ? '' : 's'}`
  return (
    <Stack gap={2}>
      <Text size="sm">{`#${payload.number} ${payload.title}`}</Text>
      <Text size="sm">
        {payload.conflicts.length > 0
          ? `${commits} behind ${payload.base}, and merging it conflicts in ${payload.conflicts.join(', ')}.`
          : `${commits} behind ${payload.base}.`}
      </Text>
      <Text size="sm" c="dimmed">
        {payload.role !== null && `The ${payload.role}'s run ends (it counts as stopped). `}
        {`The Implementer merges ${payload.base}, resolves conflicts, runs the type check and tests, and commits. The ticket goes to Review afterwards.`}
      </Text>
    </Stack>
  )
}

function Receipt({ result }: { result: UpdateFromMainResult }): ReactElement {
  const openTicket = useMainbus((s) => s.openTicket)
  return (
    <Text size="sm" c="dimmed">
      Started an update from {result.base} on{' '}
      <Anchor component="button" type="button" size="sm" title={result.title} onClick={() => openTicket(result.ticketId)}>
        #{result.number}
      </Anchor>
    </Text>
  )
}

/** Update from main has nothing to change: the card only confirms or rejects. */
export const updateFromMainView: ProposalView<UpdateFromMainPayload, UpdateFromMainResult, undefined> = {
  summary: (p) => `Update #${p.number} ${p.title} from ${p.base}`,
  Body,
  Receipt
}
