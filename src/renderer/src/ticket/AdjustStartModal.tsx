import { Button, Center, Checkbox, Group, Loader, Modal, Stack, Text } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import type { LineupRole } from '../../../shared/domain'
import { invoke } from '../api'
import { showError } from '../notify'

interface Props {
  opened: boolean
  onClose: () => void
  /** Starts the ticket with the ticked roles; resolves true once it has started. */
  onStart: (roleIds: string[]) => Promise<boolean>
}

/** "Adjust before starting": pick the lineup roles to run this time, all ticked to begin with. */
export function AdjustStartModal({ opened, onClose, onStart }: Props): ReactElement {
  return (
    <Modal opened={opened} onClose={onClose} title="Adjust before starting">
      {/* Mounted while open only, so every opening reads the lineup afresh with every role ticked. */}
      {opened && <RolePicker onClose={onClose} onStart={onStart} />}
    </Modal>
  )
}

function RolePicker({ onClose, onStart }: Omit<Props, 'opened'>): ReactElement {
  const [roles, setRoles] = useState<LineupRole[] | null>(null)
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    let cancelled = false
    invoke('lineup.get').then(
      (lineup) => {
        if (cancelled) return
        setRoles(lineup)
        setTicked(new Set(lineup.map((r) => r.id)))
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

  function toggle(id: string, on: boolean): void {
    setTicked((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function start(): Promise<void> {
    setStarting(true)
    try {
      // In lineup order, as the engine runs them.
      if (await onStart(roles!.filter((r) => ticked.has(r.id)).map((r) => r.id))) onClose()
    } finally {
      setStarting(false)
    }
  }

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        The ticked roles work the ticket in turn.
      </Text>
      {roles.map((role) => (
        <Checkbox
          key={role.id}
          label={role.name}
          checked={ticked.has(role.id)}
          onChange={(e) => toggle(role.id, e.currentTarget.checked)}
        />
      ))}
      <Group justify="flex-end" mt="xs">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={ticked.size === 0} loading={starting} onClick={() => void start()}>
          Start
        </Button>
      </Group>
    </Stack>
  )
}
