import { Anchor, Stack, Text } from '@mantine/core'
import type { ReactElement } from 'react'
import type { RoleControlPayload, RoleControlResult } from '../../../shared/proposals'
import { useMainbus } from '../store'
import type { ProposalView } from './proposalView'

type Control = 'pause' | 'stop' | 'skip'

/** What confirming does, in the words of the ticket view's controls. */
function consequence(control: Control, p: RoleControlPayload): string {
  switch (control) {
    case 'pause':
      return `The ${p.role} pauses; Resume continues it.`
    case 'stop':
      return 'The run stops and the ticket goes back to Ready.'
    case 'skip':
      return p.next
        ? `The ${p.role}'s work so far is summarised for the next role (the ${p.next}).`
        : `The ${p.role}'s work so far is summarised and the ticket goes to Review.`
  }
}

function summary(control: Control, p: RoleControlPayload): string {
  switch (control) {
    case 'pause':
      return `Pause the ${p.role} on #${p.number} ${p.title}`
    case 'stop':
      return `Stop #${p.number} ${p.title}`
    case 'skip':
      return `Skip the ${p.role} on #${p.number} ${p.title}`
  }
}

function makeView(control: Control): ProposalView<RoleControlPayload, RoleControlResult, undefined> {
  function Body({ payload }: { payload: RoleControlPayload }): ReactElement {
    return (
      <Stack gap={2}>
        <Text size="sm">{`#${payload.number} ${payload.title}`}</Text>
        <Text size="sm">{`Active role: ${payload.role}`}</Text>
        <Text size="sm" c="dimmed">
          {consequence(control, payload)}
        </Text>
      </Stack>
    )
  }

  function Receipt({ result }: { result: RoleControlResult }): ReactElement {
    const openTicket = useMainbus((s) => s.openTicket)
    const link = (
      <Anchor component="button" type="button" size="sm" title={result.title} onClick={() => openTicket(result.ticketId)}>
        #{result.number}
      </Anchor>
    )
    return (
      <Text size="sm" c="dimmed">
        {control === 'pause' && <>Paused the {result.role} on </>}
        {control === 'stop' && <>Stopped </>}
        {control === 'skip' && <>Skipped the {result.role} on </>}
        {link}
        {control === 'stop' && '; back in Ready'}
      </Text>
    )
  }

  return { summary: (p) => summary(control, p), Body, Receipt }
}

export const pauseView = makeView('pause')
export const stopView = makeView('stop')
export const skipView = makeView('skip')
