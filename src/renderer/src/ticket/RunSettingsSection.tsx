import { Alert, Button, Group, Stack, Text } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import type { LineupRole } from '../../../shared/domain'
import { applyRunSettings, choicesFromSettings, inputFromChoices, runSettingsSummary, type RoleChoice } from '../../../shared/runSettings'
import { invoke } from '../api'
import { asOwnChange } from '../board/ownChanges'
import { showError } from '../notify'
import type { BoardTicket } from '../store'
import { StartOverrideForm } from './StartOverrideForm'

/** Run settings can be changed while the ticket hasn't started: in Backlog or Ready, where no run is open. */
export function runSettingsEditable(ticket: Pick<BoardTicket, 'state'>): boolean {
  return ticket.state.column === 'backlog' || ticket.state.column === 'ready'
}

/**
 * The ticket's run settings: a one-line summary, with Edit while the ticket hasn't started. Editing uses the same form
 * as Adjust before starting; Save keeps the choices for every later start, Reset to defaults clears them.
 */
export function RunSettingsSection({ ticket }: { ticket: BoardTicket }): ReactElement {
  const [lineup, setLineup] = useState<LineupRole[] | null>(null)
  const [editing, setEditing] = useState<{ roles: RoleChoice[]; extra: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const editable = runSettingsEditable(ticket)
  const runOpen = ticket.state.column === 'in_progress' || ticket.state.column === 'needs_you'
  // Read again when the board says the lineup or the settings changed.
  const lineupKey = `${ticket.kind}|${ticket.lineup.map((r) => `${r.id}:${r.name}`).join(',')}|${JSON.stringify(ticket.runSettings)}`

  useEffect(() => {
    let cancelled = false
    // Read in the background, so a failure says nothing: the summary and Edit wait for the next board change.
    invoke('lineup.get', ticket.kind).then(
      (read) => {
        if (!cancelled && Array.isArray(read)) setLineup(read)
      },
      () => {}
    )
    return () => {
      cancelled = true
    }
  }, [lineupKey])

  // A start closes the editor: the settings are read-only once a run is open.
  useEffect(() => {
    if (!editable) setEditing(null)
  }, [editable])

  /** Saves the form's choices, or with `reset` clears the settings. */
  async function save(reset: boolean): Promise<void> {
    if (!lineup || !editing || saving) return
    setSaving(true)
    try {
      const input = reset ? null : inputFromChoices(editing.roles, lineup, editing.extra)
      await asOwnChange(ticket.id, () => invoke('ticket.setRunSettings', ticket.id, input))
      setEditing(null)
    } catch (err) {
      showError(err, 'Could not save the run settings')
    } finally {
      setSaving(false)
    }
  }

  if (editing && lineup) {
    const ticked = editing.roles.filter((r) => r.ticked).length
    return (
      <Stack gap="sm">
        <StartOverrideForm
          roles={editing.roles}
          extraInstructions={editing.extra}
          onRolesChange={(roles) => setEditing({ ...editing, roles })}
          onExtraInstructionsChange={(extra) => setEditing({ ...editing, extra })}
          rolesHint="Untick a role to skip it whenever this ticket starts."
          extraHint="Added to every role's instructions whenever this ticket starts."
        />
        <Group gap="xs">
          <Button size="compact-sm" disabled={ticked === 0} loading={saving} onClick={() => void save(false)}>
            Save
          </Button>
          {ticket.runSettings !== null && (
            <Button size="compact-sm" variant="default" disabled={saving} onClick={() => void save(true)}>
              Reset to defaults
            </Button>
          )}
          <Button size="compact-sm" variant="subtle" color="gray" disabled={saving} onClick={() => setEditing(null)}>
            Cancel
          </Button>
        </Group>
      </Stack>
    )
  }

  const summary =
    ticket.runSettings === null ? 'Lineup defaults' : lineup ? runSettingsSummary(applyRunSettings(ticket.runSettings, lineup).options, lineup) : 'Custom run'
  return (
    <Stack gap={6}>
      {ticket.runSettingsNotices.length > 0 && (
        <Alert color="needs" variant="light" p="xs" title="The lineup changed since these were saved">
          <Stack gap={2}>
            {ticket.runSettingsNotices.map((n) => (
              <Text key={n} size="sm">
                {n}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
      <Text size="sm" data-run-settings-summary>
        {summary}
      </Text>
      {editable ? (
        <Button
          w="fit-content"
          size="compact-sm"
          variant="default"
          disabled={!lineup}
          onClick={() =>
            lineup && setEditing({ roles: choicesFromSettings(lineup, ticket.runSettings), extra: ticket.runSettings?.extraInstructions ?? '' })
          }
        >
          Edit
        </Button>
      ) : (
        runOpen && (
          <Text size="xs" c="dimmed">
            Can't be changed while a run is open.
          </Text>
        )
      )}
    </Stack>
  )
}
