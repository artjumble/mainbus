import { Anchor, NativeSelect, Stack, Text, Textarea } from '@mantine/core'
import type { ReactElement } from 'react'
import type { Effort } from '../../../shared/domain'
import { EFFORT_OPTIONS, EXTRA_INSTRUCTIONS_MAX, MODEL_OPTIONS, effortLabel, modelLabel } from '../../../shared/models'
import type { ReplaceOverride, ReplacePayload, ReplaceResult } from '../../../shared/proposals'
import { useMainbus } from '../store'
import { withCurrent } from '../ticket/RoleChoice'
import type { ProposalView } from './proposalView'

/** The Override editor's state: the new run's model, effort and extra instructions. */
interface ReplaceEdit {
  model: string
  effort: Effort
  extraInstructions: string
}

function Body({ payload }: { payload: ReplacePayload }): ReactElement {
  return (
    <Stack gap={4}>
      <Text size="sm">{`#${payload.number} ${payload.title}`}</Text>
      {payload.episodeEvidence.length > 0 && (
        <>
          <Text size="sm">{`The ${payload.role} looks stuck, and a redirect did not help:`}</Text>
          <Stack gap={0} aria-label="Why it looks stuck" data-stuck-evidence>
            {payload.episodeEvidence.map((line, i) => (
              <Text key={i} size="xs" c="dimmed" ff="monospace" style={{ whiteSpace: 'pre-wrap' }}>
                {line}
              </Text>
            ))}
          </Stack>
        </>
      )}
      <Text size="sm" data-replace-plan>
        {`Its agent ends. A fresh ${payload.role} (${modelLabel(payload.model)} · ${effortLabel(payload.effort)}) starts in the same worktree, from a summary of what the first one tried, what failed and what wasn't checked.`}
      </Text>
      {payload.extraInstructions !== null && (
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }} data-extra-instructions>
          {`Extra instructions: ${payload.extraInstructions}`}
        </Text>
      )}
    </Stack>
  )
}

/** Override: the new run's model and effort, and extra instructions for it. */
function Editor({ value, onChange, payload }: { value: ReplaceEdit; onChange: (v: ReplaceEdit) => void; payload: ReplacePayload }): ReactElement {
  const efforts = withCurrent(EFFORT_OPTIONS, value.effort).map((o) => ({ ...o, label: effortLabel(o.value) }))
  return (
    <Stack gap="sm">
      <Stack gap={6} role="group" aria-label={`New ${payload.role}`}>
        <NativeSelect
          size="xs"
          label="Model"
          data={withCurrent(MODEL_OPTIONS, value.model)}
          value={value.model}
          onChange={(e) => onChange({ ...value, model: e.currentTarget.value })}
        />
        <NativeSelect
          size="xs"
          label="Effort"
          data={efforts}
          value={value.effort}
          onChange={(e) => onChange({ ...value, effort: e.currentTarget.value as Effort })}
        />
      </Stack>
      <Textarea
        label="Extra instructions"
        description={`Added to the new ${payload.role}'s instructions, for this run only.`}
        size="xs"
        autosize
        minRows={2}
        maxRows={8}
        maxLength={EXTRA_INSTRUCTIONS_MAX}
        value={value.extraInstructions}
        onChange={(e) => onChange({ ...value, extraInstructions: e.currentTarget.value })}
      />
    </Stack>
  )
}

function Receipt({ result }: { result: ReplaceResult }): ReactElement {
  const openTicket = useMainbus((s) => s.openTicket)
  return (
    <Text size="sm" c="dimmed">
      {`Replaced the ${result.role} on `}
      <Anchor component="button" type="button" size="sm" title={result.title} onClick={() => openTicket(result.ticketId)}>
        #{result.number}
      </Anchor>
      {` (${modelLabel(result.model)} · ${effortLabel(result.effort)})`}
    </Text>
  )
}

export const replaceView: ProposalView<ReplacePayload, ReplaceResult, ReplaceEdit> = {
  summary: (p) => `Replace the ${p.role} on #${p.number} ${p.title}`,
  confirmLabel: (p) => `Replace ${p.role}`,
  rejectLabel: 'Keep current',
  Body,
  initialEdit: (p) => ({ model: p.model, effort: p.effort, extraInstructions: p.extraInstructions ?? '' }),
  Editor,
  toOverride: (edit): ReplaceOverride | null => (edit.model === '' ? null : { model: edit.model, effort: edit.effort, extraInstructions: edit.extraInstructions }),
  Receipt
}
