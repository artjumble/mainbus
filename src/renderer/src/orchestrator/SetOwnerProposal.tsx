import { Anchor, Group, Stack, Text } from '@mantine/core'
import type { ReactElement } from 'react'
import type { SetOwnerPayload, SetOwnerResult } from '../../../shared/proposals'
import { YouBadge } from '../board/YouBadge'
import { useMainbus } from '../store'
import { HAND_TO_AGENTS_EFFECT } from '../ticket/HandToAgentsModal'
import type { ProposalView } from './proposalView'

const MINE_EFFECT = 'No agent will start on it; unattended mode and start proposals skip it.'

function Body({ payload }: { payload: SetOwnerPayload }): ReactElement {
  return (
    <Stack gap={2}>
      <Group gap="xs" wrap="nowrap">
        <Text size="sm">{`#${payload.number} ${payload.title}`}</Text>
        {payload.owner === 'human' && <YouBadge />}
      </Group>
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{`Why: ${payload.reason}`}</Text>
      <Text size="sm" c="dimmed">
        {payload.owner === 'human' ? MINE_EFFECT : HAND_TO_AGENTS_EFFECT}
      </Text>
    </Stack>
  )
}

function Receipt({ result }: { result: SetOwnerResult }): ReactElement {
  const openTicket = useMainbus((s) => s.openTicket)
  return (
    <Text size="sm" c="dimmed">
      {result.owner === 'human' ? 'Marked ' : 'Handed '}
      <Anchor component="button" type="button" size="sm" title={result.title} onClick={() => openTicket(result.ticketId)}>
        #{result.number}
      </Anchor>
      {result.owner === 'human' ? ' as yours' : ' to agents'}
    </Text>
  )
}

export const setOwnerView: ProposalView<SetOwnerPayload, SetOwnerResult, unknown> = {
  summary: (p) => (p.owner === 'human' ? `Mark #${p.number} ${p.title} as yours` : `Hand #${p.number} ${p.title} to agents`),
  confirmLabel: (p) => (p.owner === 'human' ? 'Mark as yours' : 'Hand to agents'),
  Body,
  Receipt
}
