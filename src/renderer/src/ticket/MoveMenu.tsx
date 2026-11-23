import { Button, Group, Menu, Modal, Stack, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useRef, useState, type ReactElement } from 'react'
import { agentsMayAct } from '../../../shared/owner'
import { invoke } from '../api'
import { asOwnChange } from '../board/ownChanges'
import { showError } from '../notify'
import { HandToAgentsModal } from './HandToAgentsModal'
import { useMainbus, type BoardTicket, type ManualColumn } from '../store'

const TARGETS: { id: ManualColumn; title: string }[] = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'ready', title: 'Ready' },
  { id: 'done', title: 'Done' }
]

const ASKED_MESSAGE = "This ticket's folder is no longer a git worktree. Open the ticket to decide whether to delete it."
const DIRTY_MESSAGE = 'This ticket has uncommitted changes in its folder. Ask the Implementer to commit them first.'

/** Moves the ticket and says so when the engine can't finish (uncommitted changes, or a folder that needs the user's answer) or refuses. */
export async function moveWithNotices(
  move: (id: string, to: ManualColumn) => Promise<'moved' | 'dirty' | 'asked'>,
  ticketId: string,
  to: ManualColumn
): Promise<void> {
  try {
    const result = await move(ticketId, to)
    if (result === 'dirty') {
      notifications.show({ color: 'needs', title: "Can't move this ticket yet", message: DIRTY_MESSAGE })
    } else if (result === 'asked') {
      notifications.show({ color: 'needs', title: 'Mainbus needs your answer first', message: ASKED_MESSAGE })
    }
  } catch (err) {
    showError(err, "Can't move this ticket")
  }
}

interface Props {
  ticket: BoardTicket
  /** Which agent's run is open (working, paused or waiting); null when no agent is. Moving the ticket stops it. */
  openRun: { role: string; status: 'running' | 'paused' | 'waiting for you' } | null
  disabled: boolean
}

/**
 * The ticket view's move: the way out of In progress and Needs you, which the board doesn't allow by drag. A ticket
 * with an open agent asks first, naming what the move does; Cancel is focused.
 */
export function MoveMenu({ ticket, openRun, disabled }: Props): ReactElement {
  const move = useMainbus((s) => s.moveTicket)
  const announce = useMainbus((s) => s.announce)
  const [asking, setAsking] = useState<ManualColumn | null>(null)
  const [moving, setMoving] = useState(false)
  const [handing, setHanding] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)

  function close(): void {
    setAsking(null)
    // The menu item that opened the question is gone: focus goes back to the control.
    setTimeout(() => opener.current?.focus(), 0)
  }

  async function run(to: ManualColumn): Promise<void> {
    setMoving(true)
    try {
      await moveWithNotices(move, ticket.id, to)
    } finally {
      setMoving(false)
    }
  }

  function choose(to: ManualColumn): void {
    if (openRun) setAsking(to)
    else void run(to)
  }

  async function confirm(): Promise<void> {
    const to = asking
    if (to === null) return
    await run(to)
    close()
  }

  /** Mine / Hand to agents: the engine refuses a Done ticket and an open run, and says why. */
  async function setOwner(owner: 'human' | 'agent'): Promise<boolean> {
    try {
      await asOwnChange(ticket.id, () => invoke('ticket.setOwner', ticket.id, owner).then(() => undefined))
      announce(owner === 'human' ? `Marked #${ticket.number} as yours` : `Handed #${ticket.number} to agents`)
      return true
    } catch (err) {
      showError(err, owner === 'human' ? "Can't mark it as yours" : "Can't hand it to agents")
      return false
    }
  }

  const target = TARGETS.find((t) => t.id === asking)?.title ?? ''
  return (
    <>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Button ref={opener} size="compact-sm" variant="default" disabled={disabled || moving}>
            Move to…
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {TARGETS.map((t) => (
            <Menu.Item key={t.id} disabled={ticket.state.column === t.id} onClick={() => choose(t.id)}>
              {t.title}
            </Menu.Item>
          ))}
          <Menu.Divider />
          <Menu.Label>Owner</Menu.Label>
          {agentsMayAct(ticket) ? (
            <Menu.Item onClick={() => void setOwner('human')}>Mine</Menu.Item>
          ) : (
            <Menu.Item onClick={() => setHanding(true)}>Hand to agents</Menu.Item>
          )}
        </Menu.Dropdown>
      </Menu>
      <HandToAgentsModal number={ticket.number} opened={handing} onClose={() => setHanding(false)} onConfirm={() => setOwner('agent')} returnFocus={false} />
      <Modal opened={asking !== null && openRun !== null} onClose={close} title={`Move to ${target}`} returnFocus={false}>
        <Stack gap="md">
          <Text size="sm">
            {`#${ticket.number} is ${openRun?.status ?? 'running'} (${openRun?.role ?? 'agent'}). Moving it to ${target} stops its agent; the work so far stays on its branch, but the run must start again. Move it?`}
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" data-autofocus onClick={close} disabled={moving}>
              Cancel
            </Button>
            <Button color="red" onClick={() => void confirm()} loading={moving}>
              Move and stop
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  )
}
