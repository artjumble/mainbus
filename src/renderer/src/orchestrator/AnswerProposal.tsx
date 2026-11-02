import { Anchor, Radio, Stack, Text, TextInput } from '@mantine/core'
import type { ReactElement } from 'react'
import type { AnswerChoice, AnswerPayload, AnswerResult, JudgementReason } from '../../../shared/proposals'
import { useMainbus } from '../store'
import type { ProposalView } from './proposalView'

/** The Override editor's state: the option picked (its index, or a permission's choice) and the note. */
interface AnswerEdit {
  choice: string
  note: string
}

const REASONS: Record<JudgementReason, string> = {
  widens_intent: 'this would widen your intent',
  open_question: 'this settles an open product or architecture question',
  recurring_theme: 'this repeats a theme that has come up before',
  destructive: 'this is destructive'
}

const PERMISSION_VALUES = ['allow_once', 'always_allow', 'deny'] as const

/** The choice each label stands for, in the order of `options`: option indexes, or a permission's values. */
function choiceValues(p: AnswerPayload): AnswerChoice[] {
  if (p.decisionKind === 'question') return p.options.map((_, i) => i)
  return PERMISSION_VALUES.filter((v) => v !== 'always_allow' || p.allowAlways)
}

function labelOf(p: AnswerPayload, choice: AnswerChoice | null): string | null {
  if (choice === null) return null
  return p.options[choiceValues(p).indexOf(choice)] ?? null
}

function Question({ payload }: { payload: AnswerPayload }): ReactElement {
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">{`#${payload.number} ${payload.title}`}</Text>
      <Text size="sm" fw={600} style={{ whiteSpace: 'pre-wrap' }}>
        {payload.question}
      </Text>
    </Stack>
  )
}

function Body({ payload }: { payload: AnswerPayload }): ReactElement {
  const j = payload.judgement
  const recommended = labelOf(payload, payload.choice)
  if (!j) {
    return (
      <Stack gap="xs">
        <Question payload={payload} />
        <Text size="sm">{`Recommended answer: ${recommended}`}</Text>
        {payload.note !== null && <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{`Note: ${payload.note}`}</Text>}
      </Stack>
    )
  }
  return (
    <Stack gap="xs">
      <Question payload={payload} />
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{`Your requirement: ${j.requirement}`}</Text>
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{`Proposed: ${j.proposed}`}</Text>
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{`Smallest option within your intent: ${j.smallest_option}`}</Text>
      <Stack gap={2}>
        <Text size="sm" fw={600}>
          If you choose…
        </Text>
        {j.consequences.map((c) => (
          <Text key={c.option} size="sm" style={{ whiteSpace: 'pre-wrap' }}>{`${c.option}: ${c.consequence}`}</Text>
        ))}
      </Stack>
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
        {`Recommendation: ${j.recommendation}${recommended === null ? '' : ` (${recommended})`}`}
      </Text>
    </Stack>
  )
}

function Editor({ payload, value, onChange }: { payload: AnswerPayload; value: AnswerEdit; onChange: (v: AnswerEdit) => void }): ReactElement {
  const values = choiceValues(payload)
  return (
    <Stack gap="xs">
      <Question payload={payload} />
      <Radio.Group label="Answer with" value={value.choice} onChange={(choice) => onChange({ ...value, choice })}>
        <Stack gap={4} mt={4}>
          {values.map((v, i) => (
            <Radio key={String(v)} value={String(v)} label={payload.options[i]} />
          ))}
        </Stack>
      </Radio.Group>
      <TextInput label="Note to the agent" value={value.note} onChange={(e) => onChange({ ...value, note: e.currentTarget.value })} />
    </Stack>
  )
}

function Receipt({ result }: { result: AnswerResult }): ReactElement {
  const openTicket = useMainbus((s) => s.openTicket)
  return (
    <Text size="sm" c="dimmed">
      {'Answered '}
      <Anchor component="button" type="button" size="sm" title={result.title} onClick={() => openTicket(result.ticketId)}>
        #{result.number}
      </Anchor>
      {` with "${result.answer}"${result.note === null ? '' : ` (note: ${result.note})`}`}
    </Text>
  )
}

/**
 * Answering a decision. A plain recommendation has Confirm, Override (pick another option, edit the note) and
 * Reject. One that needs the user's own judgement lays out the requirement, the proposal and each option's
 * consequence, and its buttons are the options themselves: nothing is pre-selected and there is no Confirm.
 */
export const answerView: ProposalView<AnswerPayload, AnswerResult, AnswerEdit> = {
  summary: (p) => (p.judgement ? `Needs your judgement: ${REASONS[p.judgement.reason]}` : `Answer #${p.number}: ${p.question}`),
  Body,
  initialEdit: (p) => ({ choice: String(p.choice ?? ''), note: p.note ?? '' }),
  Editor,
  toOverride(edit) {
    if (edit.choice === '') return null
    const choice = /^\d+$/.test(edit.choice) ? Number(edit.choice) : (edit.choice as AnswerChoice)
    return { choice, note: edit.note.trim() === '' ? null : edit.note.trim() }
  },
  choices(p) {
    if (!p.judgement) return null
    return choiceValues(p).map((v, i) => ({ label: p.options[i]!, override: { choice: v, note: p.note } }))
  },
  Receipt
}
