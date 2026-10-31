import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import { ActionIcon, Badge, Box, Button, Group, Menu, Paper, Stack, Text, Title } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { memo, useCallback, useMemo, useState, type KeyboardEvent, type ReactElement } from 'react'
import type { Column } from '../../../shared/domain'
import { invoke } from '../api'
import { showError } from '../notify'
import { useMainbus, type BoardTicket } from '../store'
import { NewTicketModal } from './NewTicketModal'
import { RoleSettings } from '../workspace/RoleSettings'
import { TicketCard } from './TicketCard'

const COLUMNS: { id: Column; title: string }[] = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'ready', title: 'Ready' },
  { id: 'in_progress', title: 'In progress' },
  { id: 'needs_you', title: 'Needs you' },
  { id: 'review', title: 'Review' },
  { id: 'done', title: 'Done' }
]

/** The only columns a person can place a card in by hand; the rest follow the agent's work. Any card can be moved. */
type ManualColumn = 'backlog' | 'ready' | 'done'
const MANUAL: { id: ManualColumn; title: string }[] = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'ready', title: 'Ready' },
  { id: 'done', title: 'Done' }
]
const isManual = (c: string): c is ManualColumn => MANUAL.some((m) => m.id === c)

const DIRTY_MESSAGE = 'This ticket has uncommitted changes in its folder. Ask the Implementer to commit them first.'

export function Board(): ReactElement {
  const workspace = useMainbus((s) => s.workspace)
  const tickets = useMainbus((s) => s.tickets)
  const openTicket = useMainbus((s) => s.openTicket)
  const refreshBoard = useMainbus((s) => s.refreshBoard)
  const [creating, setCreating] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // A small drag distance keeps a plain click on a card a click.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  /** Asks the engine to move a ticket; it refuses moves it can't make (an open run, uncommitted work) with a message. */
  const moveTicket = useCallback(async (ticket: BoardTicket, target: ManualColumn): Promise<void> => {
    if (ticket.state.column === target) return
    try {
      const result = await invoke('ticket.move', ticket.id, target)
      if (result === 'dirty') {
        notifications.show({ color: 'needs', title: "Can't move this ticket yet", message: DIRTY_MESSAGE })
        return
      }
      await refreshBoard()
    } catch (err) {
      showError(err, "Can't move this ticket")
    }
  }, [refreshBoard])

  // Stable props and per-column arrays, so a refresh re-renders only the cards that changed.
  const onMove = useCallback((t: BoardTicket, to: ManualColumn) => void moveTicket(t, to), [moveTicket])
  const byColumn = useMemo(
    () => new Map(COLUMNS.map((c) => [c.id, tickets.filter((t) => t.state.column === c.id)])),
    [tickets]
  )

  function onDragEnd({ active, over }: DragEndEvent): void {
    const target = over ? String(over.id) : null
    const ticket = tickets.find((t) => t.id === active.id)
    if (ticket && target !== null && isManual(target)) void moveTicket(ticket, target)
  }

  return (
    <Stack gap="md" p="md" h="100%">
      <Group justify="space-between">
        <Group gap="sm" align="baseline">
          <Title order={2}>{workspace?.name ?? 'Board'}</Title>
          {workspace && (
            <Text size="sm" c="dimmed">
              {workspace.repoPath}
            </Text>
          )}
        </Group>
        <Group gap="xs">
          <ActionIcon variant="default" size="lg" aria-label="Workspace settings" onClick={() => setSettingsOpen(true)}>
            <span aria-hidden>⚙</span>
          </ActionIcon>
          <Button onClick={() => setCreating(true)}>New ticket</Button>
        </Group>
      </Group>

      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(6, minmax(220px, 1fr))',
            gap: 'var(--mantine-spacing-sm)',
            overflowX: 'auto',
            alignItems: 'start'
          }}
        >
          {COLUMNS.map((c) => (
            <BoardColumn
              key={c.id}
              id={c.id}
              title={c.title}
              tickets={byColumn.get(c.id) ?? []}
              onOpen={openTicket}
              onMove={onMove}
            />
          ))}
        </Box>
      </DndContext>

      <NewTicketModal opened={creating} onClose={() => setCreating(false)} />
      <RoleSettings opened={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </Stack>
  )
}

interface ColumnProps {
  id: Column
  title: string
  tickets: BoardTicket[]
  onOpen: (id: string) => void
  onMove: (ticket: BoardTicket, to: ManualColumn) => void
}

const BoardColumn = memo(function BoardColumn({ id, title, tickets, onOpen, onMove }: ColumnProps): ReactElement {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !isManual(id) })
  const headingId = `column-${id}`
  return (
    <Paper
      ref={setNodeRef}
      component="section"
      aria-labelledby={headingId}
      p="xs"
      radius="md"
      withBorder
      bg={isOver ? 'working.0' : 'transparent'}
      mih={160}
    >
      <Group justify="space-between" mb="xs" px={4}>
        <Title order={3} size="h5" id={headingId}>
          {title}
        </Title>
        <Badge variant="default" size="sm" circle data-testid="column-count">
          {tickets.length}
        </Badge>
      </Group>
      <Stack gap="xs">
        {tickets.map((t) => (
          <DraggableTicket key={t.id} ticket={t} onOpen={onOpen} onMove={onMove} />
        ))}
      </Stack>
    </Paper>
  )
})

interface DraggableProps {
  ticket: BoardTicket
  onOpen: (id: string) => void
  onMove: (ticket: BoardTicket, to: ManualColumn) => void
}

/**
 * Any card can be dragged; only drop targets are restricted. The same move is also reachable without dragging:
 * a menu opened by right-click, the context-menu key or Shift+F10 on the focused card.
 */
const DraggableTicket = memo(function DraggableTicket({ ticket, onOpen, onMove }: DraggableProps): ReactElement {
  const { setNodeRef, listeners, transform, isDragging } = useDraggable({ id: ticket.id })
  const [menuOpen, setMenuOpen] = useState(false)

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault()
      setMenuOpen(true)
    }
  }

  return (
    <Menu
      opened={menuOpen}
      // Only our own handlers open it; Menu.Target's built-in click toggle must not.
      onChange={(opened) => {
        if (!opened) setMenuOpen(false)
      }}
      position="bottom-start"
      withinPortal
    >
      <Menu.Target>
        <div
          ref={setNodeRef}
          {...listeners}
          onKeyDown={onKeyDown}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenuOpen(true)
          }}
          style={{
            transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
            opacity: isDragging ? 0.8 : 1,
            position: 'relative',
            zIndex: isDragging ? 1 : undefined,
            touchAction: 'none'
          }}
        >
          <TicketCard ticket={ticket} onOpen={onOpen} />
        </div>
      </Menu.Target>
      <Menu.Dropdown>
        {MANUAL.map((m) => (
          <Menu.Item key={m.id} disabled={ticket.state.column === m.id} onClick={() => onMove(ticket, m.id)}>
            Move to {m.title}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  )
})
