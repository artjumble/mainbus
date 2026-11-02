import { Badge, Button, Paper, Radio, Stack, Text, Textarea } from '@mantine/core'
import { useState, type ReactElement } from 'react'
import type { AnsweredVia, Decision, DecisionAnswer } from '../../../shared/domain'
import { invoke } from '../api'
import { showAgentError } from './agentError'

interface Props {
  decision: Decision
}

/** Sends an answer from `via`; resolves false (after showing why) when the engine refused it. */
export async function sendAnswer(decision: Decision, answer: DecisionAnswer, via: AnsweredVia): Promise<boolean> {
  try {
    await invoke('decision.answer', decision.id, answer, via)
    return true
  } catch (err) {
    showAgentError(err, 'Could not send your answer')
    return false
  }
}

/**
 * The options of a question, with the recommended one marked, an optional note and the Answer button. The
 * thread card and the board card's popover both show it; `via` says which one this is.
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
      <Button w="fit-content" disabled={choice === null} loading={sending} onClick={() => void submit()}>
        Answer
      </Button>
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
        {decision.status === 'pending' ? <QuestionForm decision={decision} via="thread" /> : <Outcome decision={decision} />}
      </Stack>
    </Paper>
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
