import { Button, Center, Group, Loader, Modal, Stack } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import type { Lineup, StartOptions } from '../../../shared/domain'
import { resolveModelEffort } from '../../../shared/models'
import { invoke } from '../api'
import { showError } from '../notify'
import type { RoleChoice } from './RoleChoice'
import { StartOverrideForm } from './StartOverrideForm'

interface Props {
  opened: boolean
  onClose: () => void
  /** Starts the ticket with these options; resolves true once it has started. */
  onStart: (opts: StartOptions) => Promise<boolean>
  /** The ticket's kind: which lineup's roles to offer. */
  lineup: Lineup
}

/**
 * "Adjust before starting": the Override form (the same one the orchestrator's start proposal opens) over the lineup's
 * roles, all ticked to begin with, each with its own model and effort (its setting, else Mainbus's default).
 */
export function AdjustStartModal({ opened, onClose, onStart, lineup }: Props): ReactElement {
  return (
    <Modal opened={opened} onClose={onClose} title="Adjust before starting" size="lg">
      {/* Mounted while open only, so every opening reads the lineup afresh with every role ticked. */}
      {opened && <RolePicker onClose={onClose} onStart={onStart} lineup={lineup} />}
    </Modal>
  )
}

function RolePicker({ onClose, onStart, lineup: kind }: Omit<Props, 'opened'>): ReactElement {
  const [roles, setRoles] = useState<RoleChoice[] | null>(null)
  const [extra, setExtra] = useState('')
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    let cancelled = false
    invoke('lineup.get', kind).then(
      (lineup) => {
        if (cancelled) return
        setRoles(
          lineup.map((role) => {
            const { model, effort } = resolveModelEffort(role)
            return { roleId: role.id, name: role.name, ticked: true, model, effort }
          })
        )
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

  if (!roles) {
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
