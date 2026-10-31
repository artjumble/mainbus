import { Button, Group, Paper, Stack, Text } from '@mantine/core'
import { useState, type ReactElement } from 'react'
import type { Decision } from '../../../shared/domain'
import { sendAnswer } from './DecisionCard'

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

/** A tool-permission request from the agent: Allow once, Always allow in this workspace (when offered), Deny. */
export function PermissionCard({ decision }: Props): ReactElement {
  const [sending, setSending] = useState(false)

  async function choose(choice: Choice): Promise<void> {
    if (sending) return
    setSending(true)
    await sendAnswer(decision, { kind: 'permission', choice })
    setSending(false)
  }

  return (
    <Paper withBorder p="sm" radius="md" data-event="permission" bg="var(--mantine-color-needs-0)">
      <Stack gap="xs">
        <Text size="sm" fw={600} style={{ whiteSpace: 'pre-wrap' }}>
          {decision.question}
        </Text>
        {decision.status === 'pending' ? (
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
          </Group>
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
