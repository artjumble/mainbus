import { Anchor, Stack, Text, Textarea } from '@mantine/core'
import type { ReactElement } from 'react'
import { EXTRA_INSTRUCTIONS_MAX, effortLabel, modelLabel } from '../../../shared/models'
import type { StartLineupOverride, StartLineupPayload, StartLineupResult } from '../../../shared/proposals'
import { useMainbus } from '../store'
import { RoleChoiceRow, type RoleChoice } from '../ticket/RoleChoice'
import type { ProposalView } from './proposalView'

export interface StartLineupEdit {
  roles: RoleChoice[]
  extraInstructions: string
}

/** The roles in the order they run, each with its model and effort, then the extra instructions. */
function Body({ payload }: { payload: StartLineupPayload }): ReactElement {
  return (
    <Stack gap={4}>
      <Stack gap={2} component="ol" aria-label="Roles" style={{ margin: 0, paddingInlineStart: 20 }}>
        {payload.roles.map((r) => (
          <Text key={r.roleId} component="li" size="sm">
            {`${r.name} · ${modelLabel(r.model)} · ${effortLabel(r.effort)}`}
          </Text>
        ))}
      </Stack>
      {payload.extraInstructions !== null && (
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }} data-extra-instructions>
          {`Extra instructions: ${payload.extraInstructions}`}
        </Text>
      )}
    </Stack>
  )
}

/** Override: a box per role (one always stays ticked), its model and effort, and the extra instructions. */
function Editor({ value, onChange }: { value: StartLineupEdit; onChange: (v: StartLineupEdit) => void }): ReactElement {
  const tickedCount = value.roles.filter((r) => r.ticked).length
  const setRole = (i: number, patch: Partial<RoleChoice>): void =>
    onChange({ ...value, roles: value.roles.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  return (
    <Stack gap="sm">
      <Stack gap={6} role="group" aria-label="Models and effort per role">
        <Text size="xs" fw={500}>
          Models and effort per role
        </Text>
        {value.roles.map((role, i) => (
          <RoleChoiceRow key={role.roleId} choice={role} keepTicked={tickedCount === 1} onChange={(patch) => setRole(i, patch)} />
        ))}
      </Stack>
      <Textarea
        label="Extra instructions"
        description="Added to every role's instructions in this run."
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

/** "Started #12 with Implementer and Reviewer", the number opening the ticket. */
function Receipt({ result }: { result: StartLineupResult }): ReactElement {
  const openTicket = useMainbus((s) => s.openTicket)
  const names = result.roles.map((r) => r.name)
  const list = names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  return (
    <Text size="sm" c="dimmed">
      Started{' '}
      <Anchor component="button" type="button" size="sm" title={result.title} onClick={() => openTicket(result.ticketId)}>
        #{result.number}
      </Anchor>
      {` with ${list}`}
    </Text>
  )
}

export const startLineupView: ProposalView<StartLineupPayload, StartLineupResult, StartLineupEdit> = {
  summary: (p) => `Start #${p.number} ${p.title}`,
  Body,
  initialEdit: (p) => ({
    roles: p.roles.map((r) => ({ roleId: r.roleId, name: r.name, ticked: true, model: r.model, effort: r.effort })),
    extraInstructions: p.extraInstructions ?? ''
  }),
  Editor,
  toOverride: (edit): StartLineupOverride | null => {
    const roles = edit.roles.filter((r) => r.ticked).map((r) => ({ roleId: r.roleId, model: r.model, effort: r.effort }))
    return roles.length === 0 ? null : { roles, extraInstructions: edit.extraInstructions }
  },
  Receipt
}
