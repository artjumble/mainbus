import { Button, Group, Paper, Stack, Text } from '@mantine/core'
import { useState, type ReactElement } from 'react'
import type { CardVia, Decision } from '../../../shared/domain'
import { DeferredNote, sendAnswer } from './DecisionCard'
import { LaterMenu } from './LaterMenu'
import { PermissionAsk } from './PermissionAsk'

interface Props {
  decision: Decision
}

type Choice = 'allow_once' | 'always_allow' | 'deny'

/** How each choice reads once it is made. */
export const PERMISSION_ANSWERS: Record<Choice, string> = {
  allow_once: 'Allowed once',
  always_allow: 'Always allowed in this workspace',
  deny: 'Denied'
}

/** Allow once, Always allow in this workspace (when offered) and Deny: in the thread card and on the board card's popover. */
export function PermissionChoices({
  decision,
  via,
  onAnswered
}: Props & { via: CardVia; onAnswered?: (option?: string) => void }): ReactElement {
  const [sending, setSending] = useState(false)

  async function choose(choice: Choice): Promise<void> {
    if (sending) return
    setSending(true)
    const sent = await sendAnswer(decision, { kind: 'permission', choice }, via)
    setSending(false)
    if (sent) onAnswered?.(PERMISSION_ANSWERS[choice])
  }

  return (
    <Group gap="xs">
      <Button disabled={sending} onClick={() => void choose('allow_once')}>
        Allow once
      </Button>
      {decision.allowAlways && (
        <Button variant="default" disabled={sending} onClick={() => void choose('always_allow')}>
          Always allow in this workspace
        </Button>
      )}
      <Button variant="default" disabled={sending} onClick={() => void choose('deny')}>
        Deny
      </Button>
      {decision.status === 'pending' && <LaterMenu decision={decision} onDeferred={onAnswered} />}
    </Group>
  )
}

/** A tool-permission request from the agent, inline in the thread. */
export function PermissionCard({ decision }: Props): ReactElement {
  return (
    <Paper withBorder p="sm" radius="md" data-event="permission" bg="var(--mantine-color-needs-0)">
      <Stack gap="xs">
        <PermissionAsk decision={decision} />
        {decision.status === 'deferred' && <DeferredNote decision={decision} />}
        {decision.status === 'pending' || decision.status === 'deferred' ? (
          <PermissionChoices decision={decision} via="thread" />
        ) : (
          <Text size="sm" c="dimmed">
            {outcome(decision)}
          </Text>
        )}
      </Stack>
    </Paper>
  )
}

function outcome(decision: Decision): string {
  if (decision.status === 'answered' && decision.answer?.kind === 'permission') {
    return `✓ Answered: ${PERMISSION_ANSWERS[decision.answer.choice]}`
  }
  if (decision.status === 'cancelled') return 'Cancelled'
  return 'Expired — the agent can no longer receive this answer.'
}
