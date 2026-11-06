import { Button, Center, Checkbox, Group, Loader, Modal, Stack } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import type { LineupRole, RunSettings, StartOptions, TicketKind } from '../../../shared/domain'
import { choicesFromSettings, inputFromChoices } from '../../../shared/runSettings'
import { invoke } from '../api'
import { asOwnChange } from '../board/ownChanges'
import { showError } from '../notify'
import type { RoleChoice } from './RoleChoice'
import { StartOverrideForm } from './StartOverrideForm'

interface Props {
  opened: boolean
  onClose: () => void
  /** Starts the ticket with these options; resolves true once it has started. */
  onStart: (opts: StartOptions) => Promise<boolean>
  ticket: { id: string; kind: TicketKind; runSettings: RunSettings | null }
  /** Whether the ticket's run settings may be saved from here: only while it is in Backlog or Ready. */
  canSave: boolean
}

/**
 * "Adjust before starting": the Override form (the same one the orchestrator's start proposal opens) over the lineup's
 * roles, filled in from the ticket's run settings (else every role ticked, each with its setting or Mainbus's default).
 * Changes apply to this start only, unless "Save as this ticket's run settings" is ticked.
 */
export function AdjustStartModal({ opened, onClose, onStart, ticket, canSave }: Props): ReactElement {
  return (
    <Modal opened={opened} onClose={onClose} title="Adjust before starting" size="lg">
      {/* Mounted while open only, so every opening reads the lineup and the run settings afresh. */}
      {opened && <RolePicker onClose={onClose} onStart={onStart} ticket={ticket} canSave={canSave} />}
    </Modal>
  )
}

function RolePicker({ onClose, onStart, ticket, canSave }: Omit<Props, 'opened'>): ReactElement {
  const [lineup, setLineup] = useState<LineupRole[] | null>(null)
  const [roles, setRoles] = useState<RoleChoice[] | null>(null)
  const [extra, setExtra] = useState(ticket.runSettings?.extraInstructions ?? '')
  const [save, setSave] = useState(false)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    let cancelled = false
    invoke('lineup.get', ticket.kind).then(
      (read) => {
        if (cancelled) return
        setLineup(read)
        setRoles(choicesFromSettings(read, ticket.runSettings))
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

  if (!roles || !lineup) {
    return (
      <Center py="md">
        <Loader size="sm" />
      </Center>
    )
  }

  const ticked = roles.filter((r) => r.ticked)

  async function start(): Promise<void> {
    setStarting(true)
    try {
      if (save && canSave) {
        try {
          await asOwnChange(ticket.id, () => invoke('ticket.setRunSettings', ticket.id, inputFromChoices(roles!, lineup!, extra)))
        } catch (err) {
          showError(err, "Could not save the run settings, so the ticket wasn't started")
          return
        }
      }
      // In lineup order, as the engine runs them.
      const opts: StartOptions = {
        roleIds: ticked.map((r) => r.roleId),
        roles: Object.fromEntries(ticked.map((r) => [r.roleId, { model: r.model, effort: r.effort }])),
        ...(extra.trim() !== '' ? { extraInstructions: extra } : {})
      }
      if (await onStart(opts)) onClose()
    } finally {
      setStarting(false)
    }
  }

  return (
    <Stack gap="sm">
      <StartOverrideForm roles={roles} extraInstructions={extra} onRolesChange={setRoles} onExtraInstructionsChange={setExtra} />
      {canSave && (
        <Checkbox label="Save as this ticket's run settings" checked={save} onChange={(e) => setSave(e.currentTarget.checked)} />
      )}
      <Group justify="flex-end" mt="xs">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={ticked.length === 0} loading={starting} onClick={() => void start()}>
          Start
        </Button>
      </Group>
    </Stack>
  )
}
