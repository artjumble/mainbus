import { Button, Group, Popover, Stack, Text } from '@mantine/core'
import { useState, type ReactElement } from 'react'
import type { Decision } from '../../../shared/domain'
import { QuestionForm } from '../thread/DecisionCard'
import { PermissionChoices } from '../thread/PermissionCard'

interface Props {
  /** The ticket's open decisions, oldest first; the oldest is the one shown. */
  decisions: Decision[]
}

/**
 * The Answer control on a Needs you card: a popover on the card with the oldest open decision, answered with
 * the thread card's own option, note and permission components. Clicks and keys inside it never reach the
 * card, which would open the ticket.
 */
export function BoardAnswer({ decisions }: Props): ReactElement | null {
  const [opened, setOpened] = useState(false)
  const decision = decisions[0]
  if (!decision) return null

  return (
    <Popover opened={opened} onChange={setOpened} width={340} position="bottom-start" withArrow shadow="md" trapFocus>
      <Popover.Target>
        <Button
          size="compact-xs"
          mt={6}
          onClick={(e) => {
            e.stopPropagation()
            setOpened((o) => !o)
          }}
        >
          Answer
        </Button>
      </Popover.Target>
      <Popover.Dropdown
        // The dropdown is portaled, but React events still bubble to the card.
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Stack gap="xs">
          {decisions.length > 1 && (
            <Text size="xs" c="dimmed">
              1 of {decisions.length}
            </Text>
          )}
          <Text size="sm" fw={600} style={{ whiteSpace: 'pre-wrap' }}>
            {decision.question}
          </Text>
          {/* Keyed by decision, so the next one starts without the last one's choice and note. */}
          {decision.kind === 'permission' ? (
            <Group key={decision.id}>
              <PermissionChoices decision={decision} via="board" onAnswered={() => setOpened(false)} />
            </Group>
          ) : (
            <QuestionForm key={decision.id} decision={decision} via="board" onAnswered={() => setOpened(false)} />
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  )
}
