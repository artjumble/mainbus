import { Badge, Button, Group, Paper, Radio, Stack, Text, Textarea } from '@mantine/core'
import { useState, type ReactElement } from 'react'
import type { AnsweredVia, Decision, DecisionAnswer } from '../../../shared/domain'
import { deferredLabel } from '../../../shared/hold'
import { invoke } from '../api'
import { asOwnChange } from '../board/ownChanges'
import { showAgentError } from './agentError'
import { LaterMenu } from './LaterMenu'

interface Props {
  decision: Decision
}

/** Sends an answer from `via`; resolves false (after showing why) when the engine refused it. */
export async function sendAnswer(decision: Decision, answer: DecisionAnswer, via: AnsweredVia): Promise<boolean> {
  try {
    await asOwnChange(decision.ticketId, () => invoke('decision.answer', decision.id, answer, via))
    return true
  } catch (err) {
    showAgentError(err, 'Could not send your answer')
    return false
  }
}

/**
 * The options of a question, with the recommended one marked, an optional note and the Answer button. The
 * thread card and the board card's popover both show it; `via` says which one this is. A pending one also offers
 * Later…; `onAnswered` is called once it is answered or put off.
 */
export function QuestionForm({
  decision,
  via,
  onAnswered
}: Props & { via: AnsweredVia; onAnswered?: () => void }): ReactElement {
  const [choice, setChoice] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)

  async function submit(): Promise<void> {
    if (choice === null || sending) return
    setSending(true)
    const trimmed = note.trim()
    const sent = await sendAnswer(decision, { kind: 'option', index: Number(choice), ...(trimmed ? { note: trimmed } : {}) }, via)
    setSending(false)
    if (sent) onAnswered?.()
  }

  return (
    <>
      <Radio.Group value={choice} onChange={setChoice} aria-label={decision.question}>
        <Stack gap={6}>
          {decision.options.map((option, i) => (
            <Radio
              key={i}
              value={String(i)}
              label={
                <>
                  {option}
                  {decision.recommended === i && (
                    <Badge size="xs" variant="light" ml="xs">
                      Recommended
                    </Badge>
                  )}
                </>
              }
            />
          ))}
        </Stack>
      </Radio.Group>
      <Textarea
        label="Note (optional)"
        autosize
        minRows={1}
        maxRows={4}
        value={note}
        onChange={(e) => setNote(e.currentTarget.value)}
      />
      <Group gap="xs">
        <Button w="fit-content" disabled={choice === null} loading={sending} onClick={() => void submit()}>
          Answer
        </Button>
        {decision.status === 'pending' && <LaterMenu decision={decision} onDeferred={onAnswered} />}
      </Group>
    </>
  )
}

/** A question from the agent, inline in the thread: pick an option, add a note, answer. */
export function DecisionCard({ decision }: Props): ReactElement {
  return (
    <Paper withBorder p="sm" radius="md" data-event="decision" bg="var(--mantine-color-needs-0)">
      <Stack gap="xs">
        <Text size="sm" fw={600} style={{ whiteSpace: 'pre-wrap' }}>
          {decision.question}
        </Text>
        {decision.status === 'deferred' && <DeferredNote decision={decision} />}
        {decision.status === 'pending' || decision.status === 'deferred' ? (
          <QuestionForm decision={decision} via="thread" />
        ) : (
          <Outcome decision={decision} />
        )}
      </Stack>
    </Paper>
  )
}

/** "Deferred until Tue", above the answer controls of a decision the user put off. */
export function DeferredNote({ decision }: Props): ReactElement | null {
  if (decision.deferredUntil === null) return null
  return (
    <Text size="xs" c="dimmed" data-deferred-note>
      {deferredLabel(decision.deferredUntil, new Date())}
    </Text>
  )
}

function Outcome({ decision }: Props): ReactElement {
  if (decision.status === 'answered' && decision.answer?.kind === 'option') {
    const { index, note } = decision.answer
    return (
      <>
        <Text size="sm" c="dimmed">
          {`✓ Answered: ${decision.options[index] ?? `option ${index + 1}`}`}
        </Text>
        {note && (
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {note}
          </Text>
        )}
      </>
    )
  }
  if (decision.status === 'cancelled') return <Text size="sm" c="dimmed">Cancelled</Text>
  return (
    <Text size="sm" c="dimmed">
      Expired — the agent no longer needs this
    </Text>
  )
}
