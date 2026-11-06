import { Alert, Button, Center, Group, Loader, Modal, Stack, Text } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import type { LineupRole, TicketState } from '../../../shared/domain'
import { choicesFromSettings, inputFromChoices } from '../../../shared/runSettings'
import { invoke } from '../api'
import { asOwnChange } from '../board/ownChanges'
import { showError } from '../notify'
import type { BoardTicket } from '../store'
import type { RoleChoice } from './RoleChoice'
import { StartOverrideForm } from './StartOverrideForm'

/** Run settings can be changed whenever the ticket has no open run: before its first start, or after a run has ended. */
export function runSettingsEditable(state: TicketState): boolean {
  return (state.agentStatus === null && !state.canContinue) || state.agentStatus === 'handed_off' || state.agentStatus === 'failed'
}

interface Props {
  opened: boolean
  onClose: () => void
  ticket: BoardTicket
  /** False while a run is open or launching: the dialog then only shows the saved settings. */
  editable: boolean
}

/**
 * A ticket's run settings: the Override form (the same one the orchestrator's start proposal opens) over the lineup's
 * roles, filled in from the saved settings (else every role ticked, each with Mainbus's default). Save keeps the choices
 * for every start of the ticket and Reset to defaults clears them; nothing here starts the ticket.
 */
export function RunSettingsModal({ opened, onClose, ticket, editable }: Props): ReactElement {
  return (
    <Modal opened={opened} onClose={onClose} title="Run settings" size="lg">
      {/* Mounted while open only, so every opening reads the lineup and the run settings afresh. */}
      {opened && <Editor onClose={onClose} ticket={ticket} editable={editable} />}
    </Modal>
  )
}

function Editor({ onClose, ticket, editable }: Omit<Props, 'opened'>): ReactElement {
  const [lineup, setLineup] = useState<LineupRole[] | null>(null)
  const [draft, setDraft] = useState<{ roles: RoleChoice[]; extra: string } | null>(null)
  const [saving, setSaving] = useState<'save' | 'reset' | null>(null)

  useEffect(() => {
    let cancelled = false
    invoke('lineup.get', ticket.kind).then(
      (read) => {
        if (cancelled) return
        setLineup(read)
        setDraft({ roles: choicesFromSettings(read, ticket.runSettings), extra: ticket.runSettings?.extraInstructions ?? '' })
      },
      (err: unknown) => {
        if (cancelled) return
        showError(err, 'Could not load the lineup')
        onClose()
      }
    )
    return () => {
      cancelled = true
    }
    // Once per opening: a new onClose from the parent must not read the lineup again and reset the ticks.
  }, [])

  if (!lineup || !draft) {
    return (
      <Center py="md">
        <Loader size="sm" />
      </Center>
    )
  }

  // Read-only shows what is saved, so a draft is dropped if a run starts while the dialog is open.
  const shown = editable ? draft : { roles: choicesFromSettings(lineup, ticket.runSettings), extra: ticket.runSettings?.extraInstructions ?? '' }

  async function save(reset: boolean): Promise<void> {
    if (!lineup || !draft || saving) return
    setSaving(reset ? 'reset' : 'save')
    try {
      const input = reset ? null : inputFromChoices(draft.roles, lineup, draft.extra)
      await asOwnChange(ticket.id, () => invoke('ticket.setRunSettings', ticket.id, input))
      onClose()
    } catch (err) {
      showError(err, 'Could not save the run settings')
      setSaving(null)
    }
  }

  return (
    <Stack gap="sm">
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
      <StartOverrideForm
        roles={shown.roles}
        extraInstructions={shown.extra}
        onRolesChange={(roles) => setDraft({ ...draft, roles })}
        onExtraInstructionsChange={(extra) => setDraft({ ...draft, extra })}
        rolesHint="Untick a role to skip it whenever this ticket starts."
        extraHint="Added to every role's instructions whenever this ticket starts."
        disabled={!editable}
      />
      {editable ? (
        <Group justify="space-between" mt="xs">
          <Button
            variant="default"
            disabled={ticket.runSettings === null || saving !== null}
            loading={saving === 'reset'}
            onClick={() => void save(true)}
          >
            Reset to defaults
          </Button>
          <Group gap="xs">
            <Button variant="default" disabled={saving !== null} onClick={onClose}>
              Cancel
            </Button>
            <Button loading={saving === 'save'} disabled={saving === 'reset'} onClick={() => void save(false)}>
              Save
            </Button>
          </Group>
        </Group>
      ) : (
        <Group justify="space-between" mt="xs">
          <Text size="sm" c="dimmed">
            Can't be changed while a run is open.
          </Text>
          <Button variant="default" onClick={onClose}>
            Close
          </Button>
        </Group>
      )}
    </Stack>
  )
}
