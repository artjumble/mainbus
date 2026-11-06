import {
  DndContext,
  KeyboardCode,
  KeyboardSensor,
  PointerSensor,
  useDndContext,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type KeyboardCoordinateGetter
} from '@dnd-kit/core'
import {
  ActionIcon,
  Box,
  Button,
  Center,
  CloseButton,
  Group,
  Loader,
  Menu,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
  VisuallyHidden
} from '@mantine/core'
import { useHotkeys, useReducedMotion } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type KeyboardEventHandler,
  type ReactElement
} from 'react'
import type { Column } from '../../../shared/domain'
import { useExpandOnHover } from '../expandOnHover'
import { showError } from '../notify'
import { useMainbus, type BoardTicket, type ManualColumn } from '../store'
import { NewTicketModal } from './NewTicketModal'
import { matchesSearch } from './search'
import { TicketCard } from './TicketCard'
import { UnattendedSwitch } from './UnattendedSwitch'

const COLUMNS: { id: Column; title: string }[] = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'ready', title: 'Ready' },
  { id: 'in_progress', title: 'In progress' },
  { id: 'needs_you', title: 'Needs you' },
  { id: 'review', title: 'Review' },
  { id: 'done', title: 'Done' }
]

/** The only columns a person can place a card in by hand; the rest follow the agent's work. Any card can be moved. */
const MANUAL: { id: ManualColumn; title: string }[] = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'ready', title: 'Ready' },
  { id: 'done', title: 'Done' }
]
const isManual = (c: string): c is ManualColumn => MANUAL.some((m) => m.id === c)

/** What "Ask orchestrator to draft tickets" puts in the orchestrator's message box. */
export const DRAFT_PREFILL = 'Draft tickets for '

/**
 * Arrow Left and Right carry a card being moved by keyboard to the next column that takes drops, skipping the
 * ones that don't; Up and Down do nothing, since the order inside a column isn't a thing.
 */
export const columnCoordinates: KeyboardCoordinateGetter = (event, { context, currentCoordinates }) => {
  if (event.code !== KeyboardCode.Left && event.code !== KeyboardCode.Right) return undefined
  const rects = context.droppableContainers
    .getEnabled()
    .map((c) => context.droppableRects.get(c.id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .sort((a, b) => a.left - b.left)
  const next =
    event.code === KeyboardCode.Right
      ? rects.find((r) => r.left > currentCoordinates.x)
      : rects.findLast((r) => r.right <= currentCoordinates.x)
  if (!next) return undefined
  // Inside the column, near its top, so the card's rectangle overlaps that column and no other.
  return { x: next.left + 8, y: next.top + 48 }
}

/** The width of a column shown as a narrow strip: Done always, Needs you while it has no tickets. */
const STRIP = '44px'
const FULL_TRACK = 'minmax(120px, 1fr)'
// Same shape as a full track, so the grid can animate between the two: the strip's flex share goes to the others.
const STRIP_TRACK = `minmax(${STRIP}, 0fr)`

/**
 * The board's grid: Done is a strip at the right, Needs you one too while it is empty, and the other full columns
 * share the rest. `--column-width` is one full column's width, the width Done opens to.
 */
export function gridStyle(needsYouCollapsed: boolean): CSSProperties {
  const full = needsYouCollapsed ? 4 : 5
  const strips = COLUMNS.length - full
  const tracks = COLUMNS.map((c) =>
    c.id === 'done' ? STRIP : c.id === 'needs_you' && needsYouCollapsed ? STRIP_TRACK : FULL_TRACK
  )
  return {
    display: 'grid',
    gridTemplateColumns: tracks.join(' '),
    gap: 'var(--mantine-spacing-sm)',
    overflowX: 'auto',
    // The board fills the height left under the header, and each lane the board's: an empty lane is full height, and
    // a drop anywhere in it lands in it. A lane with more cards makes the board taller, and the page scrolls.
    flex: '1 0 auto',
    alignItems: 'stretch',
    // The containing block of the columns' visually hidden text, so it scrolls with the board, not the page.
    position: 'relative',
    // So 100cqw is the board's width, and Done open is exactly as wide as one of the other columns' tracks.
    containerType: 'inline-size',
    '--strip': STRIP,
    '--column-width': `max(120px, calc((100cqw - ${strips} * var(--strip) - ${COLUMNS.length - 1} * var(--mantine-spacing-sm)) / ${full}))`
  } as CSSProperties
}

/** A lane is a fill a step away from the ground, with no outline and square corners, unlike the cards on it. */
const LANE = 'var(--mainbus-color-lane)'

const columnTitle = (id: unknown): string => COLUMNS.find((c) => c.id === id)?.title ?? String(id)

const SCREEN_READER_INSTRUCTIONS = {
  draggable:
    'To move this ticket, press Space, then the Left or Right arrow key to choose a column, then Space again to drop it. Press Escape to cancel.'
}

const DIRTY_MESSAGE = 'This ticket has uncommitted changes in its folder. Ask the Implementer to commit them first.'

export function Board(): ReactElement {
  const workspace = useMainbus((s) => s.workspace)
  const tickets = useMainbus((s) => s.tickets)
  const openTicket = useMainbus((s) => s.openTicket)
  const pendingMoves = useMainbus((s) => s.pendingMoves)
  const move = useMainbus((s) => s.moveTicket)
  const proposeStart = useMainbus((s) => s.proposeStart)
  const empty = useMainbus((s) => s.boardLoaded && s.tickets.length === 0)
  const search = useMainbus((s) => s.search)
  const setSearch = useMainbus((s) => s.setSearch)
  const recentlyChanged = useMainbus((s) => s.recentlyChanged)
  const askOrchestrator = useMainbus((s) => s.askOrchestrator)
  const [creating, setCreating] = useState(false)
  const openSettings = useMainbus((s) => s.openSettings)
  // A small drag distance keeps a plain click on a card a click.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: columnCoordinates })
  )

  /**
   * Shows the card in the target column at once and asks the engine to move it; the engine refuses moves it
   * can't make (an open run, uncommitted work), and the card then goes back. One move per card at a time.
   */
  const moveTicket = useCallback(
    async (ticket: BoardTicket, target: ManualColumn): Promise<void> => {
      if (ticket.id in useMainbus.getState().pendingMoves || ticket.state.column === target) return
      try {
        const result = await move(ticket.id, target)
        if (result === 'dirty') {
          notifications.show({ color: 'needs', title: "Can't move this ticket yet", message: DIRTY_MESSAGE })
        }
      } catch (err) {
        showError(err, "Can't move this ticket")
      }
    },
    [move]
  )

  /**
   * Dragging a Backlog or Ready card into In progress doesn't move it: it proposes starting it, in the
   * orchestrator panel. The card stays where it is until the proposal is confirmed.
   */
  const onPropose = useCallback(
    async (ticket: BoardTicket): Promise<void> => {
      const column = ticket.state.column
      if (column !== 'backlog' && column !== 'ready') return
      try {
        await proposeStart(ticket.id)
      } catch (err) {
        showError(err, "Can't start this ticket")
      }
    },
    [proposeStart]
  )

  // Stable props and per-column arrays, so a refresh re-renders only the cards that changed.
  const onMove = useCallback((t: BoardTicket, to: ManualColumn) => void moveTicket(t, to), [moveTicket])
  const byColumn = useMemo(() => {
    const shown = tickets.filter((t) => matchesSearch(t, search))
    return new Map(COLUMNS.map((c) => [c.id, shown.filter((t) => (pendingMoves[t.id] ?? t.state.column) === c.id)]))
  }, [tickets, pendingMoves, search])
  // Needs you is a strip while no ticket is in it; a search doesn't count, so the columns don't jump while typing.
  const needsYouCollapsed = !tickets.some((t) => t.state.column === 'needs_you' && !(t.id in pendingMoves))
  const reducedMotion = useReducedMotion()
  // The empty state's New ticket button is gone once the first ticket exists, so focus can have nowhere to return to
  // after the dialog closes: once the dialog is gone and focus is on nothing, send it to the header's button.
  const closeNewTicket = useCallback((): void => {
    setCreating(false)
    const settle = (tries: number): void => {
      if (document.querySelector('[role="dialog"]') && tries > 0) {
        setTimeout(() => settle(tries - 1), 50)
        return
      }
      setTimeout(() => {
        const active = document.activeElement
        if (!active || active === document.body) newTicketRef.current?.focus()
      }, 50)
    }
    setTimeout(() => settle(20), 50)
  }, [])
  const filtering = search.trim() !== ''
  const searchRef = useRef<HTMLInputElement>(null)
  const newTicketRef = useRef<HTMLButtonElement>(null)
  const focusSearch = (): void => searchRef.current?.focus()
  useHotkeys([
    ['mod+K', focusSearch],
    ['/', focusSearch]
  ])

  const moved = useRef(false)
  const announcements = useMemo<Announcements>(() => {
    const name = (id: unknown): string => {
      const t = tickets.find((x) => x.id === id)
      return t ? `ticket #${t.number} ${t.title}` : 'ticket'
    }
    const where = (id: unknown): string => {
      const title = columnTitle(id)
      return id === 'in_progress' ? `${title}, which proposes starting it` : title
    }
    return {
      onDragStart: ({ active }) => {
        moved.current = false
        return `Picked up ${name(active.id)}.`
      },
      onDragOver: ({ active, over }) => {
        if (!over) return `${name(active.id)} is not over a column.`
        // dnd-kit reports the column the card started in right after the pick-up; that would drown "Picked up".
        if (tickets.find((t) => t.id === active.id)?.state.column === over.id && !moved.current) return undefined
        moved.current = true
        return `${name(active.id)} is over ${where(over.id)}.`
      },
      onDragEnd: ({ active, over }) => {
        if (!over) return `${name(active.id)} was dropped outside a column and stays where it was.`
        if (over.id === 'in_progress') {
          return `${name(active.id)} was dropped on In progress: the orchestrator panel proposes starting it.`
        }
        return `${name(active.id)} was dropped on ${columnTitle(over.id)}.`
      },
      onDragCancel: ({ active }) => `Moving ${name(active.id)} was cancelled; it stays where it was.`
    }
  }, [tickets])

  // A card dragged towards Done, at the right edge, makes the board wider than it is, and dnd-kit would scroll it
  // sideways under the pointer, moving every column. Only let it when the columns themselves don't fit.
  const boardRef = useRef<HTMLDivElement>(null)
  const boardOverflows = useRef(false)
  const autoScroll = useMemo(
    () => ({ canScroll: (el: Element) => el !== boardRef.current || boardOverflows.current }),
    []
  )
  // The same card, carried past the board's right edge, would also give the board a sideways scrollbar for the drag,
  // and the scrollbar's height would come off every lane, Review's under Done too. While the columns fit, clip instead.
  const [clipSideways, setClipSideways] = useState(false)
  function onDragStart(): void {
    const board = boardRef.current
    boardOverflows.current = board !== null && board.scrollWidth > board.clientWidth + 1
    setClipSideways(!boardOverflows.current)
  }

  function onDragEnd({ active, over }: DragEndEvent): void {
    setClipSideways(false)
    const target = over ? String(over.id) : null
    const ticket = tickets.find((t) => t.id === active.id)
    if (!ticket || target === null) return
    if (isManual(target)) void moveTicket(ticket, target)
    else if (target === 'in_progress') void onPropose(ticket)
  }

  return (
    <Stack gap="md" p="md" style={{ flex: '1 0 auto' }}>
      <Group justify="space-between">
        <Stack gap={0}>
          <Title order={2}>{workspace?.name ?? 'Board'}</Title>
          {workspace && (
            <Text size="xs" c="dimmed">
              <Text span ff="monospace" inherit>
                {workspace.repoPath}
              </Text>
              {empty ? ' · just added' : ' · local tickets'}
            </Text>
          )}
        </Stack>
        <Group gap="md">
          {!empty && (
            <TextInput
              ref={searchRef}
              aria-label="Search tickets"
              placeholder="Search (Ctrl+K)"
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSearch('')
              }}
              rightSection={
                search !== '' ? (
                  <CloseButton
                    size="sm"
                    aria-label="Clear search"
                    onClick={() => {
                      setSearch('')
                      searchRef.current?.focus()
                    }}
                  />
                ) : null
              }
            />
          )}
          <UnattendedSwitch />
          <ActionIcon variant="default" size="lg" aria-label="Workspace settings" onClick={openSettings}>
            <span aria-hidden>⚙</span>
          </ActionIcon>
          {/* The empty board offers its own New ticket button. */}
          {!empty && (
            <Button ref={newTicketRef} onClick={() => setCreating(true)}>
              New ticket
            </Button>
          )}
        </Group>
      </Group>

      {empty ? (
        <Box pos="relative" style={{ flex: '1 0 auto', display: 'flex', flexDirection: 'column' }}>
          {/* The lanes the board will have, full height, with their names: no scrolling, they share the width. */}
          <Box aria-hidden style={{ ...gridStyle(false), gridTemplateColumns: `repeat(5, minmax(0, 1fr)) ${STRIP}`, overflowX: 'hidden' }}>
            {COLUMNS.map((c) => (
              <Paper key={c.id} data-lane radius={0} bg={LANE} p="xs">
                <Text
                  size="xs"
                  fw={700}
                  tt="uppercase"
                  lts="0.04em"
                  c="dimmed"
                  style={c.id === 'done' ? { writingMode: 'vertical-rl' } : undefined}
                >
                  {c.title}
                </Text>
              </Paper>
            ))}
          </Box>
          {/* The message lies over the lanes, on a surface of its own. */}
          <Center pos="absolute" inset={0} p="md">
            <Paper withBorder shadow="sm" radius="md" maw={460} p="md">
              <Stack align="center" gap="sm" ta="center">
                <Title order={3}>No tickets in {workspace?.name ?? 'this workspace'} yet</Title>
                <Text c="dimmed">
                  Write one yourself, or have the orchestrator read the repo and draft a starter set for you to review.
                </Text>
                <Group gap="sm" justify="center">
                  <Button onClick={() => setCreating(true)}>New ticket</Button>
                  <Button variant="default" onClick={() => askOrchestrator(DRAFT_PREFILL)}>
                    Ask orchestrator to draft tickets
                  </Button>
                </Group>
              </Stack>
            </Paper>
          </Center>
        </Box>
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setClipSideways(false)}
          autoScroll={autoScroll}
          accessibility={{ announcements, screenReaderInstructions: SCREEN_READER_INSTRUCTIONS }}
        >
          <Box
            ref={boardRef}
            style={{
              ...gridStyle(needsYouCollapsed),
              ...(clipSideways ? { overflowX: 'hidden' } : {}),
              transition: reducedMotion ? 'none' : 'grid-template-columns 150ms ease'
            }}
          >
            {COLUMNS.map((c) => {
              const props: ColumnProps = {
                id: c.id,
                title: c.title,
                tickets: byColumn.get(c.id) ?? [],
                pendingMoves,
                recentlyChanged,
                filtering,
                onOpen: openTicket,
                onMove,
                onPropose
              }
              return c.id === 'done' ? (
                <DoneColumn key={c.id} {...props} />
              ) : (
                <BoardColumn key={c.id} {...props} collapsed={c.id === 'needs_you' && needsYouCollapsed} />
              )
            })}
          </Box>
        </DndContext>
      )}

      <NewTicketModal opened={creating} onClose={closeNewTicket} />
    </Stack>
  )
}

interface ColumnProps {
  id: Column
  title: string
  tickets: BoardTicket[]
  pendingMoves: Record<string, ManualColumn>
  recentlyChanged: Record<string, number>
  /** A search is on: an empty column says "No matches" instead of the quiet placeholder. */
  filtering: boolean
  onOpen: (id: string) => void
  onMove: (ticket: BoardTicket, to: ManualColumn) => void
  onPropose: (ticket: BoardTicket) => void
}

const BoardColumn = memo(function BoardColumn({
  id,
  title,
  tickets,
  pendingMoves,
  recentlyChanged,
  filtering,
  onOpen,
  onMove,
  onPropose,
  collapsed = false
}: ColumnProps & {
  /** Needs you with no tickets: a narrow strip with its title and count, like Done's, that never opens. */
  collapsed?: boolean
}): ReactElement {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !isManual(id) && id !== 'in_progress' })
  const headingId = `column-${id}`
  if (collapsed) {
    return (
      <Paper
        ref={setNodeRef}
        component="section"
        aria-label={`${title}, no tickets`}
        data-collapsed
        data-lane
        p="xs"
        radius={0}
        bg="needs.0"
        style={{ overflow: 'hidden', minWidth: 0 }}
      >
        <Stack align="center" gap="xs">
          <Text size="xs" c="dimmed" data-testid="column-count" aria-hidden>
            0
          </Text>
          <Title order={3} size="xs" tt="uppercase" lts="0.04em" id={headingId} style={{ writingMode: 'vertical-rl' }}>
            {title}
          </Title>
        </Stack>
      </Paper>
    )
  }
  return (
    <Paper
      ref={setNodeRef}
      component="section"
      aria-labelledby={headingId}
      data-lane
      p="xs"
      radius={0}
      bg={isOver ? 'working.0' : id === 'needs_you' ? 'needs.0' : LANE}
    >
      <Group justify="space-between" mb="xs" px={4}>
        <Title order={3} size="xs" tt="uppercase" lts="0.04em" id={headingId}>
          {title}
        </Title>
        <Text size="xs" c="dimmed" data-testid="column-count" aria-hidden>
          {tickets.length}
        </Text>
        <VisuallyHidden>{ticketCount(tickets.length)}</VisuallyHidden>
      </Group>
      <ColumnCards
        tickets={tickets}
        pendingMoves={pendingMoves}
        recentlyChanged={recentlyChanged}
        filtering={filtering}
        onOpen={onOpen}
        onMove={onMove}
        onPropose={onPropose}
      />
    </Paper>
  )
})

const ticketCount = (n: number): string => (n === 1 ? '1 ticket' : `${n} tickets`)

function ColumnCards({
  tickets,
  pendingMoves,
  recentlyChanged,
  filtering,
  onOpen,
  onMove,
  onPropose,
  hidden = false
}: Omit<ColumnProps, 'id' | 'title'> & { hidden?: boolean }): ReactElement {
  return (
    // Hidden: out of sight, out of the tab order and away from screen readers, but still there for dnd-kit to
    // give focus back to a card dropped in a closed Done.
    <Stack gap="xs" inert={hidden} display={hidden ? 'none' : undefined}>
      {tickets.length === 0 && (
        <Text size="xs" c="dimmed" ta="center" py="md">
          {filtering ? 'No matches' : 'Nothing here'}
        </Text>
      )}
      {tickets.map((t) => (
        <DraggableTicket
          key={t.id}
          ticket={t}
          movingTo={pendingMoves[t.id] ?? null}
          changedAt={recentlyChanged[t.id]}
          onOpen={onOpen}
          onMove={onMove}
          onPropose={onPropose}
        />
      ))}
    </Stack>
  )
}

/**
 * Done, whose cards are rarely needed, is a narrow strip with its title and count. It opens to a full column
 * over Review, without moving the other columns: on hover, while focus is inside it, and while a card is
 * dragged over it or out of it. Closed, its cards are hidden from sight, the tab order and screen readers.
 */
const DoneColumn = memo(function DoneColumn({ id, title, tickets, pendingMoves, ...rest }: ColumnProps): ReactElement {
  const { setNodeRef, isOver, active } = useDroppable({ id })
  const { measureDroppableContainers } = useDndContext()
  const reducedMotion = useReducedMotion()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  // A Done card being dragged out must not vanish under the pointer.
  const draggingFromHere = active != null && tickets.some((t) => t.id === active.id)
  const open = useExpandOnHover(isOver || focused || draggingFromHere, hovered)
  const cleaningUp = tickets.some((t) => pendingMoves[t.id] === 'done')
  const headingId = `column-${id}`
  const countId = `column-${id}-count`

  // With no animation there is no transitionend: measure the new width straight away.
  useEffect(() => {
    if (reducedMotion) measureDroppableContainers([id])
  }, [open, reducedMotion, measureDroppableContainers, id])

  function onBlur(e: FocusEvent<HTMLElement>): void {
    if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false)
  }

  const style: CSSProperties = {
    // The track stays as wide as the strip; open, the negative margin makes it grow to the left, over Review.
    width: open ? 'var(--column-width)' : 'var(--strip)',
    marginLeft: open ? 'calc(var(--strip) - var(--column-width))' : 0,
    position: 'relative',
    zIndex: 2,
    // Clipped while it widens or narrows; but a card dragged out of it is still its child, and must stay in sight.
    overflow: draggingFromHere ? 'visible' : 'hidden',
    boxShadow: open ? 'var(--mantine-shadow-md)' : undefined,
    // Open, its edge over Review, a lane of the same fill, shows as a line too; never a top or bottom border.
    borderLeft: open ? '1px solid var(--mainbus-color-card-border)' : undefined,
    transition: reducedMotion ? 'none' : 'width 150ms ease, margin-left 150ms ease'
  }

  return (
    <Paper
      ref={setNodeRef}
      component="section"
      aria-labelledby={headingId}
      aria-describedby={countId}
      tabIndex={0}
      className="mantine-focus-auto"
      data-expanded={open}
      data-lane
      p="xs"
      radius={0}
      // Opaque, so open it covers Review.
      bg={isOver ? 'working.0' : LANE}
      style={style}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
      // dnd-kit measures droppables when a drag starts; Done widens during one, and once it has its final width a
      // drop anywhere in it must land in it, so measure it again then.
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && e.propertyName === 'width') measureDroppableContainers([id])
      }}
    >
      {open ? (
        <Group justify="space-between" mb="xs" px={4} wrap="nowrap">
          <Title order={3} size="xs" tt="uppercase" lts="0.04em" id={headingId}>
            {title}
          </Title>
          <Text size="xs" c="dimmed" data-testid="column-count" aria-hidden>
            {tickets.length}
          </Text>
        </Group>
      ) : (
        <Stack align="center" gap="xs">
          <Text size="xs" c="dimmed" data-testid="column-count" aria-hidden>
            {tickets.length}
          </Text>
          <Title order={3} size="xs" tt="uppercase" lts="0.04em" id={headingId} style={{ writingMode: 'vertical-rl' }}>
            {title}
          </Title>
          {cleaningUp && (
            <span data-testid="done-working">
              <Loader size={12} aria-hidden />
              <VisuallyHidden>Cleaning up</VisuallyHidden>
            </span>
          )}
        </Stack>
      )}
      <VisuallyHidden id={countId}>{ticketCount(tickets.length)}</VisuallyHidden>
      <ColumnCards tickets={tickets} pendingMoves={pendingMoves} {...rest} hidden={!open} />
    </Paper>
  )
})

interface DraggableProps {
  ticket: BoardTicket
  /** Where the card is being moved, while the engine has not answered; null otherwise. */
  movingTo: ManualColumn | null
  changedAt: number | undefined
  onOpen: (id: string) => void
  onMove: (ticket: BoardTicket, to: ManualColumn) => void
  onPropose: (ticket: BoardTicket) => void
}

/**
 * Any card can be dragged; only drop targets are restricted. The same move is also reachable without dragging:
 * a menu opened by right-click, the context-menu key or Shift+F10 on the focused card. A card being moved
 * can't be moved again until the engine answers.
 */
const DraggableTicket = memo(function DraggableTicket({
  ticket,
  movingTo,
  changedAt,
  onOpen,
  onMove,
  onPropose
}: DraggableProps): ReactElement {
  const moving = movingTo !== null
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, isDragging } = useDraggable({
    id: ticket.id,
    disabled: moving
  })
  // Pointer drags start anywhere on the card; a keyboard drag only from the handle, so Enter on the title still opens.
  const { onKeyDown: dragKeyDown, ...pointerListeners } = listeners ?? {}
  const handleKeyDown = dragKeyDown as KeyboardEventHandler<HTMLButtonElement> | undefined
  const [menuOpen, setMenuOpen] = useState(false)
  // The menu's target is the whole card, which can't take focus, so Mantine can't return it: do that here.
  const opener = useRef<Element | null>(null)
  const openMenu = (): void => {
    opener.current = document.activeElement
    setMenuOpen(true)
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (moving) return
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault()
      openMenu()
    }
  }

  return (
    <Menu
      opened={menuOpen}
      // Only our own handlers open it; Menu.Target's built-in click toggle must not.
      onChange={(opened) => {
        if (opened) return
        setMenuOpen(false)
        const back = opener.current
        opener.current = null
        // A card moved to another column is a new element: find its title again.
        setTimeout(() => {
          const target =
            back instanceof HTMLElement && back.isConnected
              ? back
              : document.querySelector<HTMLElement>(`[data-card-title="${ticket.id}"]`)
          // In a closed Done the card can't take focus: focusing the column opens it, then the card can.
          const closed = target?.closest('[inert]')?.closest<HTMLElement>('section')
          if (closed) {
            closed.focus()
            setTimeout(() => target?.focus(), 0)
          } else target?.focus()
        }, 0)
      }}
      position="bottom-start"
      withinPortal
    >
      <div
        ref={setNodeRef}
        {...pointerListeners}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          e.preventDefault()
          if (!moving) openMenu()
        }}
        style={{
          transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
          opacity: isDragging ? 0.8 : 1,
          position: 'relative',
          // Above Done, open over Review.
          zIndex: isDragging ? 3 : undefined,
          touchAction: 'none'
        }}
      >
        <TicketCard
          ticket={ticket}
          cleaningUp={movingTo === 'done'}
          changedAt={changedAt}
          onOpen={onOpen}
          handle={
            // The handle is the menu's target too: a button can carry the menu's ARIA, the card's div can't.
            <Menu.Target>
              <ActionIcon
                ref={setActivatorNodeRef}
                {...attributes}
                onKeyDown={handleKeyDown}
                // The card's own click opens the ticket; the handle is not that.
                onClick={(e) => e.stopPropagation()}
                variant="subtle"
                color="gray"
                size="xs"
                aria-label={`Move ticket #${ticket.number}`}
                aria-disabled={moving}
                style={{ cursor: 'grab' }}
              >
                <span aria-hidden>⠿</span>
              </ActionIcon>
            </Menu.Target>
          }
        />
      </div>
      <Menu.Dropdown>
        {MANUAL.map((m) => (
          <Menu.Item key={m.id} disabled={moving || ticket.state.column === m.id} onClick={() => onMove(ticket, m.id)}>
            Move to {m.title}
          </Menu.Item>
        ))}
        {(ticket.state.column === 'backlog' || ticket.state.column === 'ready') && (
          <Menu.Item disabled={moving} onClick={() => onPropose(ticket)}>
            Move to In progress…
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  )
})
