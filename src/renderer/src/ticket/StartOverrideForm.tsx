import { Checkbox, Collapse, Stack, Text, UnstyledButton } from '@mantine/core'
import { DictationTextarea } from '../voice/DictationTextarea'
import { useState, type ReactElement } from 'react'
import { EXTRA_INSTRUCTIONS_MAX } from '../../../shared/models'
import { useMainbus } from '../store'
import { ModelEffortRow, type RoleChoice } from './RoleChoice'

interface Props {
  roles: RoleChoice[]
  extraInstructions: string
  onRolesChange: (roles: RoleChoice[]) => void
  onExtraInstructionsChange: (text: string) => void
  /** Says how long the choices last; this start's by default. */
  rolesHint?: string
  extraHint?: string
  /** Shows the choices without letting them change. */
  disabled?: boolean
}

/**
 * The Override form for starting a ticket, shared by the orchestrator's start proposal and a ticket's Run settings:
 * the lineup's roles as numbered ticks (one always stays ticked), a collapsed section for each role's model and
 * effort, and extra instructions for this run.
 */
export function StartOverrideForm({
  roles,
  extraInstructions,
  onRolesChange,
  onExtraInstructionsChange,
  rolesHint = 'Untick a role to skip it for this ticket only.',
  extraHint = "Added to every role's instructions in this run.",
  disabled = false
}: Props): ReactElement {
  const workspaceName = useMainbus((s) => s.workspace?.name)
  const [modelsOpen, setModelsOpen] = useState(false)
  const tickedCount = roles.filter((r) => r.ticked).length
  const setRole = (i: number, patch: Partial<RoleChoice>): void =>
    onRolesChange(roles.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <Stack gap="sm">
      <Stack gap={6} role="group" aria-label="Lineup for this ticket">
        <Text size="sm" fw={600}>
          {workspaceName ? `Lineup for this ticket (from ${workspaceName})` : 'Lineup for this ticket'}
        </Text>
        {roles.map((role, i) => (
          <Checkbox
            key={role.roleId}
            label={`${i + 1}. ${role.name}`}
            checked={role.ticked}
            disabled={disabled || (tickedCount === 1 && role.ticked)}
            onChange={(e) => setRole(i, { ticked: e.currentTarget.checked })}
          />
        ))}
        <Text size="xs" c="dimmed">
          {rolesHint}
        </Text>
      </Stack>
      <Stack gap={6}>
        <UnstyledButton
          aria-expanded={modelsOpen}
          onClick={() => setModelsOpen((o) => !o)}
          style={{ fontSize: 'var(--mantine-font-size-sm)', fontWeight: 500 }}
        >
          <span aria-hidden>{modelsOpen ? '▼' : '▶'}</span> Models and effort per role
        </UnstyledButton>
        <Collapse expanded={modelsOpen}>
          <Stack gap={6} role="group" aria-label="Models and effort per role">
            {roles.map((role, i) => (
              <ModelEffortRow key={role.roleId} choice={role} disabled={disabled} onChange={(patch) => setRole(i, patch)} />
            ))}
          </Stack>
        </Collapse>
      </Stack>
      <DictationTextarea
        label="Extra instructions for this agent"
        description={extraHint}
        placeholder="Optional"
        autosize
        minRows={2}
        maxRows={8}
        maxLength={EXTRA_INSTRUCTIONS_MAX}
        value={extraInstructions}
        disabled={disabled}
        onValueChange={onExtraInstructionsChange}
      />
    </Stack>
  )
}
