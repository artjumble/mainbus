import { Anchor, Paper, Text } from '@mantine/core'
import { Fragment, type ReactElement } from 'react'
import type { ThreadEvent } from '../../../shared/events'
import { navigateTo } from '../navigation'
import { showError } from '../notify'

type Created = Extract<ThreadEvent, { kind: 'tickets_created' }>

/**
 * The receipt of tickets the orchestrator created directly in a workspace's Backlog: like a decided proposal's, with
 * a link to each ticket (focusing its workspace first) and no buttons.
 */
export function CreatedTicketsReceipt({ event }: { event: Created }): ReactElement {
  const last = event.tickets.length - 1
  const open = (ticketId: string): void => {
    navigateTo({ to: 'ticket', workspaceId: event.workspaceId, ticketId }).catch((err: unknown) => showError(err, 'Could not open that ticket'))
  }
  return (
    <Paper withBorder px="sm" py={6} radius="md" data-event="tickets_created">
      <Text size="sm" c="dimmed">
        Created{' '}
        {event.tickets.map((t, i) => (
          <Fragment key={t.id}>
            {i > 0 && (i === last ? ' and ' : ', ')}
            <Anchor component="button" type="button" size="sm" title={t.title} onClick={() => open(t.id)}>
              #{t.number}
            </Anchor>
          </Fragment>
        ))}
        {` in ${event.workspace}'s Backlog`}
      </Text>
    </Paper>
  )
}
