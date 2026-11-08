import { Anchor, Group, Stack, Text } from '@mantine/core'
import type { ReactElement } from 'react'
import { notDoneYetText } from '../../../shared/dependencies'
import type { StartLineupOverride, StartLineupPayload, StartLineupResult } from '../../../shared/proposals'
import { useMainbus } from '../store'
import { phaseLabel } from '../board/TicketCard'
import type { RoleChoice } from '../ticket/RoleChoice'
import { StartOverrideForm } from '../ticket/StartOverrideForm'
import type { ProposalView } from './proposalView'

export interface StartLineupEdit {
  roles: RoleChoice[]
  extraInstructions: string
}

/** "web-app lineup: Planner → Implementer → Reviewer", then any extra instructions. */
function Body({ payload }: { payload: StartLineupPayload }): ReactElement {
  const workspaceName = useMainbus((s) => s.workspace?.name)
  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed" aria-label="Roles">
        {`${workspaceName ? `${workspaceName} lineup` : 'Lineup'}: ${payload.roles.map((r) => r.name).join(' → ')}`}
      </Text>
      {payload.blockedBy && payload.blockedBy.length > 0 && (
        <Text size="xs" c="dimmed" data-blocked-note>
          {`${notDoneYetText(payload.blockedBy)}. Confirming starts it anyway.`}
        </Text>
      )}
      {payload.preset && (
        <Text size="xs" c="dimmed" data-preset>
          {[`Preset: ${payload.preset.name}`, ...payload.preset.notices].join('. ')}
        </Text>
      )}
      {payload.extraInstructions !== null && (
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }} data-extra-instructions>
          {`Extra instructions: ${payload.extraInstructions}`}
        </Text>
      )}
    </Stack>
  )
}

/** Override: the same form as a ticket's Run settings. */
function Editor({ value, onChange }: { value: StartLineupEdit; onChange: (v: StartLineupEdit) => void }): ReactElement {
  return (
    <StartOverrideForm
      roles={value.roles}
      extraInstructions={value.extraInstructions}
      onRolesChange={(roles) => onChange({ ...value, roles })}
      onExtraInstructionsChange={(extraInstructions) => onChange({ ...value, extraInstructions })}
    />
  )
}

/**
 * "✓ Login is in Implementing · Planner working", with an Open ticket link. The phase and the working role are the
 * ticket's now, from the board, so the line stays true as the ticket moves on.
 */
function Receipt({ result }: { result: StartLineupResult }): ReactElement {
  const openTicket = useMainbus((s) => s.openTicket)
  const ticket = useMainbus((s) => s.tickets.find((t) => t.id === result.ticketId))
  const active = ticket?.lineup.find((r) => r.active)?.name ?? result.roles[0]?.name
  const state = ticket?.state
  const line = state
    ? `✓ ${result.title} is in ${phaseLabel(state.phase)}${active && state.agentStatus === 'working' ? ` · ${active} working` : ''}`
    : `✓ Started ${result.title}${active ? ` · ${active} working` : ''}`
  return (
    <Group gap="xs">
      <Text size="sm" c="dimmed">
        {line}
      </Text>
      <Anchor component="button" type="button" size="sm" onClick={() => openTicket(result.ticketId)}>
        Open ticket
      </Anchor>
    </Group>
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
  overrideConfirmLabel: 'Start',
  toOverride: (edit): StartLineupOverride | null => {
    const roles = edit.roles.filter((r) => r.ticked).map((r) => ({ roleId: r.roleId, model: r.model, effort: r.effort }))
    return roles.length === 0 ? null : { roles, extraInstructions: edit.extraInstructions }
  },
  Receipt
}
