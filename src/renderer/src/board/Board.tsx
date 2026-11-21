import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDndContext,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Active,
  type Announcements,
  type Over,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  ActionIcon,
  Anchor,
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
import { useDebouncedValue, useHotkeys, useReducedMotion } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import {
  forwardRef,
  Fragment,
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
  type ReactElement,
  type ReactNode
} from 'react'
import { baseBranchWarning } from '../../../shared/baseBranch'
import { compareRank, isRanked } from '../../../shared/boardOrder'
import type { ArchivedTicket, Column } from '../../../shared/domain'
import { invoke } from '../api'
import { useWorkspaceBranches } from '../workspace/useWorkspaceBranches'
import { useExpandOnHover } from '../expandOnHover'
import { showError } from '../notify'
import { useMainbus, type BoardTicket, type ManualColumn } from '../store'
import { NewTicketModal } from './NewTicketModal'
import { MergeModal } from '../ticket/MergeModal'
import { ArchiveNotice } from '../archive/ArchiveNotice'
import { ArchiveOlderModal } from '../archive/ArchiveOlderModal'
import { cardRects, laneOf, makeCoordinates, slotIn } from './reorder'
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

/** The width of a column shown as a narrow strip: Done always, Needs you while it has no tickets. */
const STRIP = '44px'
const FULL_TRACK = 'minmax(120px, 1fr)'
// Same shape as a full track, so the grid can animate between the two: the strip's flex share goes to the others.
const STRIP_TRACK = `minmax(${STRIP}, 0fr)`

/** The height of a column's sticky title row. The cards' `scroll-margin-top` clears it. */
const TITLE_H = '2.5rem'
/** Where the column titles stick: just under the board's header, whose height Board measures into this variable. */
const HEADER_H = 'var(--board-header-h, 0px)'

/**
 * A column's title row, or a strip's body, stuck under the board's header while the cards scroll under it. It takes
 * the lane's fill so the cards don't show through, and the lane's padding so it spans the lane edge to edge.
 */
function stickyTitle(fill: string): CSSProperties {
  const xs = 'var(--mantine-spacing-xs)'
  return {
    position: 'sticky',
    // Tucked 1 px under the header (which is above it), so a fractional header height or zoom leaves no sliver for
    // the cards to show through; the extra top padding keeps the content where it was.
    top: `calc(${HEADER_H} - 1px)`,
    zIndex: 1,
    background: fill,
    margin: `calc(-1 * ${xs}) calc(-1 * ${xs}) 0`,
    // Every title row, and a strip's count, starts its text at the same height: the first line sits at the top.
    padding: `calc(${xs} + 1px) calc(${xs} + 4px) 0`,
    height: TITLE_H,
    boxSizing: 'border-box'
  }
}

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
    // The columns don't scroll sideways themselves, or they would be the scroll container the sticky titles stick in,
    // and they would never stick. When they don't fit, the board area scrolls: the grid keeps its smallest width.
    overflowX: 'clip',
    // Also vertically, as the old scroll container did: a card carried past the board's bottom must not grow the board area.
    overflowY: 'clip',
    minWidth: `calc(${full} * 120px + ${strips} * ${STRIP} + ${COLUMNS.length - 1} * var(--mantine-spacing-sm))`,
    // The board fills the height left under the usage banner, and each lane the board's: an empty lane is full height, and
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

/** A lane's fill: the Needs you tint, the working tint under a card being dragged over a lane, else the lane colour. */
const laneFill = (id: Column, isOver = false): string =>
  isOver ? 'working.0' : id === 'needs_you' ? 'needs.0' : LANE

/** A lane's fill as a CSS value, for the sticky title that has to match it. */
const laneCss = (id: Column, isOver = false): string =>
  isOver ? 'var(--mantine-color-working-0)' : id === 'needs_you' ? 'var(--mantine-color-needs-0)' : LANE

/** What a strip shows: the count above the title set vertically. Done's closed and Needs you's collapsed share it. */
function StripBody({
  title,
  count,
  headingId,
  fill,
  children
}: {
  title: string
  count: number
  headingId: string
  /** The lane's fill, which the stuck strip keeps. */
  fill?: string
  children?: ReactNode
}): ReactElement {
  return (
    <Stack
      align="center"
      gap="xs"
      style={fill ? { ...stickyTitle(fill), height: 'auto', paddingBottom: 'var(--mantine-spacing-xs)' } : undefined}
    >
      <Text size="xs" c="dimmed" data-testid="column-count" aria-hidden>
        {count}
      </Text>
      <Title order={3} size="xs" tt="uppercase" lts="0.04em" id={headingId} style={{ writingMode: 'vertical-rl' }}>
        {title}
      </Title>
      {children}
    </Stack>
  )
}

/** Needs you with no tickets: a narrow tinted strip that never opens. The empty board draws the same one. */
const CollapsedLane = forwardRef<HTMLElement, { title: string; headingId: string; label?: string }>(
  function CollapsedLane({ title, headingId, label = `${title}, no tickets` }, ref) {
    return (
      <Paper
        ref={ref}
        component="section"
        aria-label={label}
        data-collapsed
        data-lane
        p="xs"
        radius={0}
        bg={laneFill('needs_you')}
        // Clip, not hidden: hidden would make the lane the scroll container the strip's body sticks in.
        style={{ overflow: 'clip', minWidth: 0 }}
      >
        <StripBody title={title} count={0} headingId={headingId} fill={laneCss('needs_you')} />
      </Paper>
    )
  }
)

/**
 * The lanes of a board with no tickets, drawn from the same tracks, fills and strips as the real one but inert:
 * no drop targets, no cards. Needs you is collapsed, since nothing is in it, and Done is its strip.
 */
function PlaceholderLanes(): ReactElement {
  return (
    <Box aria-hidden style={{ ...gridStyle(true), overflowX: 'hidden', minWidth: 0 }}>
      {COLUMNS.map((c) =>
        c.id === 'needs_you' ? (
          <CollapsedLane key={c.id} title={c.title} headingId={`empty-${c.id}`} />
        ) : (
          <Paper key={c.id} component="section" data-lane radius={0} bg={laneFill(c.id)} p="xs">
            {c.id === 'done' ? (
              <StripBody title={c.title} count={0} headingId={`empty-${c.id}`} fill={laneCss(c.id)} />
            ) : (
              <Group justify="space-between" align="flex-start" wrap="nowrap" style={stickyTitle(laneCss(c.id))}>
                <Title order={3} size="xs" tt="uppercase" lts="0.04em" id={`empty-${c.id}`}>
                  {c.title}
                </Title>
                <Text size="xs" c="dimmed" data-testid="column-count">
                  0
                </Text>
              </Group>
            )}
          </Paper>
        )
      )}
    </Box>
  )
}

/**
 * What the Archive holds for the board's search: how many archived tickets match, and the one a `#N` search names.
 * Read a moment after typing stops; null when nothing is searched or nothing is archived.
 */
function useArchiveHint(search: string, archivedCount: number): { total: number; exact: ArchivedTicket | null } | null {
  const [debounced] = useDebouncedValue(search.trim(), 250)
  const [hint, setHint] = useState<{ query: string; total: number; exact: ArchivedTicket | null } | null>(null)
  useEffect(() => {
    if (debounced === '' || archivedCount === 0) {
      setHint(null)
      return
    }
    let stale = false
    invoke('archive.list', { query: debounced, limit: 1 })
      .then((r) => {
        if (stale) return
        const exact = /^#\d+$/.test(debounced) && r.total === 1 ? (r.tickets[0] ?? null) : null
        setHint({ query: debounced, total: r.total, exact })
      })
      .catch(() => {
        if (!stale) setHint(null)
      })
    return () => {
      stale = true
    }
  }, [debounced, archivedCount])
  // A stale answer must not show for words no longer in the box.
  return hint !== null && hint.query === search.trim() ? hint : null
}

/** Where a card held over Backlog or Ready would land. */
interface DropAt {
  column: Column
  /** The card it goes above; null for the bottom. */
  before: string | null
  position: number
  total: number
}

const NO_IDS: string[] = []

const columnTitle = (id: unknown): string => COLUMNS.find((c) => c.id === id)?.title ?? String(id)

const SCREEN_READER_INSTRUCTIONS = {
  draggable:
    'To move this ticket, press Space, then the Left or Right arrow key to choose a column, and in the first two columns the Up or Down arrow key to choose its place, then Space again to drop it. Press Escape to cancel.'
}

const ASKED_MESSAGE =
  "This ticket's folder is no longer a git worktree. Open the ticket to decide whether to delete it."

const DIRTY_MESSAGE = 'This ticket has uncommitted changes in its folder. Ask the Implementer to commit them first.'

export function Board(): ReactElement {
  const workspace = useMainbus((s) => s.workspace)
  const settingsOpen = useMainbus((s) => s.settingsOpen)
  const branches = useWorkspaceBranches(workspace?.id, workspace?.baseBranch, settingsOpen)
  const baseWarning = branches ? baseBranchWarning(branches) : null
  const tickets = useMainbus((s) => s.tickets)
  const openTicket = useMainbus((s) => s.openTicket)
  const pendingMoves = useMainbus((s) => s.pendingMoves)
  const pendingRanks = useMainbus((s) => s.pendingRanks)
  const move = useMainbus((s) => s.moveTicket)
  const reorder = useMainbus((s) => s.reorderTicket)
  const proposeStart = useMainbus((s) => s.proposeStart)
  const empty = useMainbus((s) => s.boardLoaded && s.tickets.length === 0)
  const search = useMainbus((s) => s.search)
  const setSearch = useMainbus((s) => s.setSearch)
  const recentlyChanged = useMainbus((s) => s.recentlyChanged)
  const askOrchestrator = useMainbus((s) => s.askOrchestrator)
  const archivedCount = useMainbus((s) => s.archivedCount)
  const openArchive = useMainbus((s) => s.openArchive)
  const archiveHint = useArchiveHint(search, archivedCount)
  const [creating, setCreating] = useState(false)
  // The ticket in Review whose Merge… dialog is open.
  const [mergeTarget, setMergeTarget] = useState<BoardTicket | null>(null)
  // "Archive all Done older than…" is open. Held here, not in the Done strip, which closes when focus leaves it.
  const [archiveOlderOpen, setArchiveOlderOpen] = useState(false)
  const openArchiveOlder = useCallback(() => setArchiveOlderOpen(true), [])
  const openSettings = useMainbus((s) => s.openSettings)
  const filtering = search.trim() !== ''
  const filteringRef = useRef(filtering)
  filteringRef.current = filtering
  const coordinateGetter = useMemo(() => makeCoordinates(() => filteringRef.current), [])
  // A small drag distance keeps a plain click on a card a click.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter })
  )
  // What a screen reader hears after a menu action; the drag has dnd-kit's own live region.
  const [status, setStatus] = useState('')

  /**
   * Shows the card in the target column at once and asks the engine to move it; the engine refuses moves it
   * can't make (an open run, uncommitted work), and the card then goes back. One move per card at a time.
   */
  const moveTicket = useCallback(
    async (ticket: BoardTicket, target: ManualColumn, before: string | null = null): Promise<void> => {
      if (ticket.id in useMainbus.getState().pendingMoves || ticket.state.column === target) return
      try {
        const result = before === null ? await move(ticket.id, target) : await move(ticket.id, target, before)
        if (result === 'dirty') {
          notifications.show({ color: 'needs', title: "Can't move this ticket yet", message: DIRTY_MESSAGE })
        } else if (result === 'asked') {
          notifications.show({ color: 'needs', title: 'Mainbus needs your answer first', message: ASKED_MESSAGE })
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
  const onArchive =useCallback(async (t: BoardTicket): Promise<void> => {
    const { announce, refreshBoard } = useMainbus.getState()
    try {
      await invoke('ticket.archive', [t.id])
      await refreshBoard()
      announce(`Archived #${t.number} ${t.title}`)
    } catch (err) {
      showError(err, "Can't archive this ticket")
      return
    }
    // The card is gone, and focus with it: back to the Done lane, which opens, and from which Archive is a Tab away.
    setTimeout(() => document.querySelector<HTMLElement>('[data-done-lane]')?.focus(), 0)
  }, [])
  // Backlog and Ready in the user's order (a pending rank shows a card in its new place at once); the rest as the engine sends them.
  const inColumn = useMemo(() => {
    const out = new Map<Column, BoardTicket[]>(COLUMNS.map((c) => [c.id, []]))
    for (const t of tickets) out.get(pendingMoves[t.id] ?? t.state.column)?.push(t)
    for (const [id, list] of out) {
      if (isRanked(id)) list.sort((a, b) => compareRank({ rank: pendingRanks[a.id] ?? a.rank, number: a.number }, { rank: pendingRanks[b.id] ?? b.rank, number: b.number }))
    }
    return out
  }, [tickets, pendingMoves, pendingRanks])
  const byColumn = useMemo(
    () => new Map(COLUMNS.map((c) => [c.id, (inColumn.get(c.id) ?? []).filter((t) => matchesSearch(t, search))])),
    [inColumn, search]
  )
  // The whole order of each column, search or not, which the menu's positions and the announcements count in.
  const orderIds = useMemo(() => new Map(COLUMNS.map((c) => [c.id, (inColumn.get(c.id) ?? []).map((t) => t.id)])), [inColumn])
  const orderRef = useRef(orderIds)
  orderRef.current = orderIds

  /** Moves a card within its column from its menu, and says where it went. */
  const onReorder = useCallback(
    async (ticket: BoardTicket, before: string | null, position: number): Promise<void> => {
      const column = ticket.state.column
      try {
        await reorder(ticket.id, before)
        const total = orderRef.current.get(column)?.length ?? position
        setStatus(`#${ticket.number} moved to position ${position} of ${total} in ${columnTitle(column)}.`)
      } catch (err) {
        showError(err, "Can't reorder this ticket")
      }
    },
    [reorder]
  )
  const [drop, setDrop] = useState<DropAt | null>(null)
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
  const searchRef = useRef<HTMLInputElement>(null)
  const newTicketRef = useRef<HTMLButtonElement>(null)
  const focusSearch = (): void => searchRef.current?.focus()
  useHotkeys([
    ['mod+K', focusSearch],
    ['/', focusSearch]
  ])

  /**
   * Where a card held over `over` would land: in Backlog or Ready, above which card (null for the bottom) and at what
   * position of how many (the card itself counted, as it will be after the drop). null over any other column.
   * While a search is on the order can't be changed: a card from another column goes to the bottom.
   */
  const dropFor = useCallback((active: Active, over: Over | null): DropAt | null => {
    if (!over) return null
    const column = String(over.id) as Column
    if (!isRanked(column)) return null
    const ids = orderRef.current.get(column) ?? []
    const own = ids.indexOf(String(active.id))
    const total = own >= 0 ? ids.length : ids.length + 1
    if (filteringRef.current) return { column, before: null, position: own >= 0 ? own + 1 : total, total }
    const rects = cardRects(laneOf(column), String(active.id))
    const moved = active.rect?.current?.translated
    const slot = moved ? slotIn(moved.top + moved.height / 2, rects) : rects.length
    return { column, before: rects[slot]?.id ?? null, position: slot + 1, total }
  }, [])

  const moved = useRef(false)
  const lastSpot = useRef('')
  const announcements = useMemo<Announcements>(() => {
    const name = (id: unknown): string => {
      const t = tickets.find((x) => x.id === id)
      return t ? `ticket #${t.number} ${t.title}` : 'ticket'
    }
    const where = (id: unknown): string => {
      const title = columnTitle(id)
      return id === 'in_progress' ? `${title}, which proposes starting it` : title
    }
    const spot = (active: Active, over: Over): string | undefined => {
      const at = dropFor(active, over)
      if (!at) return undefined
      return filteringRef.current && orderRef.current.get(at.column)?.includes(String(active.id))
        ? undefined
        : `position ${at.position} of ${at.total}`
    }
    return {
      onDragStart: ({ active }) => {
        moved.current = false
        const column = tickets.find((t) => t.id === active.id)?.state.column
        lastSpot.current = `${column}:${(orderRef.current.get(column as Column) ?? []).indexOf(String(active.id)) + 1}`
        return `Picked up ${name(active.id)}.`
      },
      onDragOver: ({ active, over }) => {
        if (!over) return `${name(active.id)} is not over a column.`
        // dnd-kit reports the column the card started in right after the pick-up; that would drown "Picked up".
        if (tickets.find((t) => t.id === active.id)?.state.column === over.id && !moved.current) return undefined
        moved.current = true
        const at = spot(active, over)
        if (at) lastSpot.current = `${over.id}:${at}`
        return `${name(active.id)} is over ${where(over.id)}${at ? `, ${at}` : ''}.`
      },
      // Inside a column, only a new place is worth saying.
      onDragMove: ({ active, over }) => {
        if (!over) return undefined
        const at = spot(active, over)
        if (!at || lastSpot.current === `${over.id}:${at}`) return undefined
        lastSpot.current = `${over.id}:${at}`
        moved.current = true
        return `${name(active.id)} is over ${where(over.id)}, ${at}.`
      },
      onDragEnd: ({ active, over }) => {
        if (!over) return `${name(active.id)} was dropped outside a column and stays where it was.`
        if (over.id === 'in_progress') {
          return `${name(active.id)} was dropped on In progress: the orchestrator panel proposes starting it.`
        }
        const t = tickets.find((x) => x.id === active.id)
        const at = dropFor(active, over)
        if (at && t) {
          if (t.state.column === at.column && filteringRef.current) {
            return `Reordering is off while a search is on; #${t.number} stays where it was.`
          }
          return `#${t.number} moved to position ${at.position} of ${at.total} in ${columnTitle(at.column)}.`
        }
        return `${name(active.id)} was dropped on ${columnTitle(over.id)}.`
      },
      onDragCancel: ({ active }) => `Moving ${name(active.id)} was cancelled; it stays where it was.`
    }
  }, [tickets, dropFor])

  const onDragSpot = useCallback(
    ({ active, over }: { active: Active; over: Over | null }): void => {
      const at = over && !(filteringRef.current && orderRef.current.get(String(over.id) as Column)?.includes(String(active.id))) ? dropFor(active, over) : null
      setDrop((prev) => (prev?.column === at?.column && prev?.before === at?.before ? prev : at && { column: at.column, before: at.before, position: at.position, total: at.total }))
    },
    [dropFor]
  )

  // The columns' grid clips sideways (see gridStyle), so a card carried past the board's right edge, towards Done,
  // neither grows a scrollbar nor scrolls the board.

  // The header's height, which the column titles stick under and the cards' scroll margin clears.
  const rootRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = rootRef.current
    const header = headerRef.current
    if (!root || !header) return
    const measure = (): void =>
      root.style.setProperty('--board-header-h', `${header.getBoundingClientRect().height}px`)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(header)
    return () => observer.disconnect()
  }, [])

  function onDragEnd({ active, over }: DragEndEvent): void {
    setDrop(null)
    const target = over ? String(over.id) : null
    const ticket = tickets.find((t) => t.id === active.id)
    if (!ticket || target === null || !over) return
    if (ticket.state.column === 'in_progress' || ticket.state.column === 'needs_you') return
    const at = dropFor(active, over)
    if (isManual(target)) {
      if (ticket.state.column !== target) void moveTicket(ticket, target, at?.before ?? null)
      else if (at && !filteringRef.current && at.position - 1 !== (orderRef.current.get(at.column) ?? []).indexOf(ticket.id)) {
        void onReorder(ticket, at.before, at.position)
      }
    } else if (target === 'in_progress') void onPropose(ticket)
  }

  return (
    <Stack ref={rootRef} gap="md" px="md" pb="md" style={{ flex: '1 0 auto' }}>
      <VisuallyHidden role="status" aria-live="polite" data-testid="board-announcer">
        {status}
      </VisuallyHidden>
      {/* Stays at the top of the board area while the board scrolls: the workspace name, search, Unattended, settings and
          New ticket. It spans the board edge to edge, on the page's own ground, so the cards don't show through. */}
      <Group
        ref={headerRef}
        justify="space-between"
        data-testid="board-header"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 5,
          background: 'var(--mantine-color-body)',
          margin: '0 calc(-1 * var(--mantine-spacing-md))',
          padding: 'var(--mantine-spacing-md) var(--mantine-spacing-md) var(--mantine-spacing-xs)'
        }}
      >
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
          {baseWarning && (
            <Text size="xs" c="needs.7" role="status">
              {baseWarning}
            </Text>
          )}
        </Stack>
        <Group gap="md">
          {!empty && (
            <Stack gap={2}>
            <TextInput
              ref={searchRef}
              aria-label="Search tickets"
              placeholder="Search (Ctrl+K)"
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSearch('')
                // An archived ticket named by number opens on Enter, not while typing: #12 comes on the way to #123.
                if (e.key === 'Enter' && archiveHint?.exact) {
                  e.preventDefault()
                  openTicket(archiveHint.exact.id)
                }
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
            <Text size="xs" role="status" data-testid="archive-hint">
              {archiveHint?.exact ? (
                <>
                  #{archiveHint.exact.number} {archiveHint.exact.title} is archived.{' '}
                  <Anchor component="button" type="button" size="xs" onClick={() => openTicket(archiveHint.exact!.id)}>
                    Open it
                  </Anchor>
                </>
              ) : archiveHint && archiveHint.total > 0 ? (
                <Anchor component="button" type="button" size="xs" onClick={() => openArchive(search.trim())}>
                  {archiveHint.total} more in the Archive
                </Anchor>
              ) : null}
            </Text>
            </Stack>
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

      <ArchiveNotice />

      {empty ? (
        <Box pos="relative" style={{ flex: '1 0 auto', display: 'flex', flexDirection: 'column' }}>
          {/* The lanes the board will have, full height, with their names: no scrolling, they share the width. */}
          <PlaceholderLanes />
          {/* The message lies over the lanes, on a surface of its own. */}
          <Center pos="absolute" inset={0} p="md">
            <Paper data-board-empty withBorder shadow="sm" radius="md" maw={460} p="md">
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
          onDragEnd={onDragEnd}
          onDragMove={onDragSpot}
          onDragOver={onDragSpot}
          onDragCancel={() => setDrop(null)}
          accessibility={{ announcements, screenReaderInstructions: SCREEN_READER_INSTRUCTIONS }}
        >
          <Box
            style={{
              ...gridStyle(needsYouCollapsed),
              transition: reducedMotion ? 'none' : 'grid-template-columns 150ms ease'
            }}
          >
            {COLUMNS.map((c) => {
              const props: ColumnProps = {
                id: c.id,
                title: c.title,
                tickets: byColumn.get(c.id) ?? [],
                columnIds: orderIds.get(c.id) ?? NO_IDS,
                dropBefore: drop?.column === c.id ? drop.before : undefined,
                pendingMoves,
                recentlyChanged,
                filtering,
                onOpen: openTicket,
                onMove,
                onReorder,
                onPropose,
                onMerge: setMergeTarget,
                onArchive
              }
              return c.id === 'done' ? (
                <DoneColumn key={c.id} {...props} onArchiveOlder={openArchiveOlder} />
              ) : (
                <BoardColumn key={c.id} {...props} collapsed={c.id === 'needs_you' && needsYouCollapsed} />
              )
            })}
          </Box>
        </DndContext>
      )}

      <NewTicketModal opened={creating} onClose={closeNewTicket} />
      <ArchiveOlderModal opened={archiveOlderOpen} onClose={() => setArchiveOlderOpen(false)} />
      {mergeTarget !== null && <MergeModal opened ticket={mergeTarget} onClose={() => setMergeTarget(null)} />}
    </Stack>
  )
}

interface ColumnProps {
  id: Column
  title: string
  tickets: BoardTicket[]
  pendingMoves: Record<string, ManualColumn>
  recentlyChanged: Record<string, number>
  /** A search is on: an empty column says "No matches" instead of the quiet placeholder, and reordering is off. */
  filtering: boolean
  /** Every ticket of the column in its order, search or not: what a card's menu counts its place in. */
  columnIds: string[]
  /** While a card is held over this column: the card its drop line goes above (null: at the end). undefined: no line. */
  dropBefore: string | null | undefined
  onReorder: (ticket: BoardTicket, before: string | null, position: number) => void
  onOpen: (id: string) => void
  onMove: (ticket: BoardTicket, to: ManualColumn) => void
  onPropose: (ticket: BoardTicket) => void
  /** Opens Merge… for a ticket in Review. */
  onMerge: (ticket: BoardTicket) => void
  /** Archives a Done ticket: it leaves the board for the Archive. */
  onArchive: (ticket: BoardTicket) => void
}

const BoardColumn = memo(function BoardColumn({
  id,
  title,
  tickets,
  pendingMoves,
  recentlyChanged,
  filtering,
  columnIds,
  dropBefore,
  onOpen,
  onMove,
  onReorder,
  onPropose,
  onMerge,
  onArchive,
  collapsed = false
}: ColumnProps & {
  /** Needs you with no tickets: a narrow strip with its title and count, like Done's, that never opens. */
  collapsed?: boolean
}): ReactElement {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !isManual(id) && id !== 'in_progress' })
  const headingId = `column-${id}`
  if (collapsed) return <CollapsedLane ref={setNodeRef} title={title} headingId={headingId} />
  return (
    <Paper
      ref={setNodeRef}
      component="section"
      aria-labelledby={headingId}
      data-lane
      p="xs"
      radius={0}
      bg={laneFill(id, isOver)}
    >
      <Group justify="space-between" align="flex-start" wrap="nowrap" style={stickyTitle(laneCss(id, isOver))}>
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
        columnIds={columnIds}
        dropBefore={dropBefore}
        onOpen={onOpen}
        onMove={onMove}
        onReorder={onReorder}
        onPropose={onPropose}
        onMerge={onMerge}
        onArchive={onArchive}
      />
    </Paper>
  )
})

/** The line a held card's drop lands at: between two cards, or after the last. */
function DropIndicator(): ReactElement {
  return <div aria-hidden data-testid="drop-indicator" style={{ height: 2, margin: '-1px 0', background: 'var(--mantine-color-working-6)' }} />
}

const ticketCount = (n: number): string => (n === 1 ? '1 ticket' : `${n} tickets`)

function ColumnCards({
  tickets,
  pendingMoves,
  recentlyChanged,
  filtering,
  columnIds,
  dropBefore,
  onOpen,
  onMove,
  onReorder,
  onPropose,
  onMerge,
  onArchive,
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
        <Fragment key={t.id}>
          {dropBefore === t.id && <DropIndicator />}
          <DraggableTicket
            ticket={t}
            movingTo={pendingMoves[t.id] ?? null}
            changedAt={recentlyChanged[t.id]}
            columnIds={columnIds}
            filtering={filtering}
            onOpen={onOpen}
            onMove={onMove}
            onReorder={onReorder}
            onPropose={onPropose}
            onMerge={onMerge}
            onArchive={onArchive}
          />
        </Fragment>
      ))}
      {dropBefore === null && <DropIndicator />}
    </Stack>
  )
}

/**
 * Done, whose cards are rarely needed, is a narrow strip with its title and count. It opens to a full column
 * over Review, without moving the other columns: on hover, while focus is inside it, and while a card is
 * dragged over it or out of it. Closed, its cards are hidden from sight, the tab order and screen readers.
 */
const DoneColumn = memo(function DoneColumn({ id, title, tickets, pendingMoves, onArchiveOlder, ...rest }: ColumnProps & { onArchiveOlder: () => void }): ReactElement {
  const { setNodeRef, isOver, active } = useDroppable({ id })
  const { measureDroppableContainers } = useDndContext()
  const reducedMotion = useReducedMotion()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  // A Done card being dragged out must not vanish under the pointer.
  const draggingFromHere = active != null && tickets.some((t) => t.id === active.id)
  const open = useExpandOnHover(isOver || focused || draggingFromHere, hovered)
  const elRef = useRef<HTMLElement | null>(null)

  // A drag can end without the column seeing pointerleave or blur: the dragged card leaves the column, or is
  // unmounted, still holding focus. Trust the document, not the flags.
  // Stable, so dnd-kit's ref is not called with null and the node again on every render of a drag.
  const setRefs = useCallback(
    (node: HTMLElement | null): void => {
      elRef.current = node
      setNodeRef(node)
    },
    [setNodeRef]
  )
  const resync = useCallback((): void => {
    const el = elRef.current
    if (!el) return
    setHovered(el.matches(':hover'))
    setFocused(el.contains(document.activeElement))
  }, [])
  const dragging = active != null
  const wasDragging = useRef(false)
  useEffect(() => {
    const ended = wasDragging.current && !dragging
    wasDragging.current = dragging
    if (!ended) return
    const timer = setTimeout(resync, 0)
    return () => clearTimeout(timer)
  }, [dragging, resync])
  // The card that held focus may go on being removed after the drop, once the engine has moved it.
  useEffect(() => {
    if (focused) resync()
  }, [tickets, focused, resync])
  const cleaningUp = tickets.some((t) => pendingMoves[t.id] === 'done')
  const archivedCount = useMainbus((s) => s.archivedCount)
  const openArchive = useMainbus((s) => s.openArchive)
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
    // Clip, not hidden: hidden would make the lane the scroll container the sticky title sticks in.
    overflow: draggingFromHere ? 'visible' : 'clip',
    boxShadow: open ? 'var(--mantine-shadow-md)' : undefined,
    // Open, its edge over Review, a lane of the same fill, shows as a line too; never a top or bottom border.
    borderLeft: open ? '1px solid var(--mainbus-color-card-border)' : undefined,
    transition: reducedMotion ? 'none' : 'width 150ms ease, margin-left 150ms ease'
  }

  return (
    <Paper
      ref={setRefs}
      component="section"
      aria-labelledby={headingId}
      aria-describedby={countId}
      tabIndex={0}
      className="mantine-focus-auto"
      data-expanded={open}
      data-done-lane
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
        <Group justify="space-between" align="flex-start" wrap="nowrap" style={stickyTitle(laneCss(id, isOver))}>
          <Title order={3} size="xs" tt="uppercase" lts="0.04em" id={headingId}>
            {title}
          </Title>
          <Text size="xs" c="dimmed" data-testid="column-count" aria-hidden>
            {tickets.length}
          </Text>
        </Group>
      ) : (
        <StripBody title={title} count={tickets.length} headingId={headingId} fill={laneCss(id, isOver)}>
          {cleaningUp && (
            <span data-testid="done-working">
              <Loader size={12} aria-hidden />
              <VisuallyHidden>Cleaning up</VisuallyHidden>
            </span>
          )}
        </StripBody>
      )}
      <VisuallyHidden id={countId}>{ticketCount(tickets.length)}</VisuallyHidden>
      {/* Outside the cards, which are inert while Done is closed; only an open Done shows it. */}
      {open && archivedCount > 0 && (
        <Button
          variant="subtle"
          size="compact-xs"
          data-archive-button
          onClick={() => openArchive()}
          styles={{ root: { marginBottom: 'var(--mantine-spacing-xs)' } }}
        >
          Archive ({archivedCount})
        </Button>
      )}
      {open && tickets.length > 0 && (
        <Button
          variant="subtle"
          size="compact-xs"
          data-archive-older-button
          onClick={onArchiveOlder}
          styles={{ root: { marginBottom: 'var(--mantine-spacing-xs)' } }}
        >
          Archive older…
        </Button>
      )}
      <ColumnCards tickets={tickets} pendingMoves={pendingMoves} {...rest} hidden={!open} />
    </Paper>
  )
})

interface DraggableProps {
  ticket: BoardTicket
  /** Where the card is being moved, while the engine has not answered; null otherwise. */
  movingTo: ManualColumn | null
  changedAt: number | undefined
  /** Every ticket of the card's column in order, for the menu's positions. */
  columnIds: string[]
  /** A search is on: reordering is off. */
  filtering: boolean
  onOpen: (id: string) => void
  onMove: (ticket: BoardTicket, to: ManualColumn) => void
  onReorder: (ticket: BoardTicket, before: string | null, position: number) => void
  onPropose: (ticket: BoardTicket) => void
  /** Opens Merge… for a ticket in Review. */
  onMerge: (ticket: BoardTicket) => void
  onArchive: (ticket: BoardTicket) => void
}

/**
 * Cards can be dragged, except in In progress and Needs you; only drop targets are restricted. The same move is also
 * reachable without dragging: a menu opened by right-click, the context-menu key or Shift+F10 on the focused card.
 * A card being moved can't be moved again until the engine answers.
 */
const DraggableTicket = memo(function DraggableTicket({
  ticket,
  movingTo,
  changedAt,
  columnIds,
  filtering,
  onOpen,
  onMove,
  onReorder,
  onPropose,
  onMerge,
  onArchive
}: DraggableProps): ReactElement {
  const moving = movingTo !== null
  const ranked = isRanked(ticket.state.column)
  const index = columnIds.indexOf(ticket.id)
  const last = columnIds.length - 1
  const canReorder = ranked && !moving && !filtering && index >= 0
  /** The four menu moves: where the card goes (its place above `before`) and its new position. */
  const reorderTo = (position: number, before: string | null): void => onReorder(ticket, before, position)
  // A running ticket can't be dragged or moved from the board: leaving In progress or Needs you stops its agent, so
  // it takes the ticket view's confirmed move.
  const locked = ticket.state.column === 'in_progress' || ticket.state.column === 'needs_you'
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, isDragging } = useDraggable({
    id: ticket.id,
    disabled: moving || locked
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

  if (locked) {
    return (
      <div
        style={{
          position: 'relative',
          scrollMarginTop: `calc(${HEADER_H} + ${TITLE_H} + var(--mantine-spacing-xs))`
        }}
      >
        <TicketCard ticket={ticket} cleaningUp={movingTo === 'done'} changedAt={changedAt} onOpen={onOpen} />
      </div>
    )
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
        data-ticket-id={ticket.id}
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
          // Scrolled into view (focus, a search result), the card stops below the sticky header and titles.
          scrollMarginTop: `calc(${HEADER_H} + ${TITLE_H} + var(--mantine-spacing-xs))`,
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
        {ranked && (
          <>
            {filtering && <Menu.Label>Clear the search to reorder</Menu.Label>}
            <Menu.Item disabled={!canReorder || index <= 0} onClick={() => reorderTo(1, columnIds[0]!)}>
              Move to top
            </Menu.Item>
            <Menu.Item disabled={!canReorder || index <= 0} onClick={() => reorderTo(index, columnIds[index - 1]!)}>
              Move up
            </Menu.Item>
            <Menu.Item disabled={!canReorder || index >= last} onClick={() => reorderTo(index + 2, columnIds[index + 2] ?? null)}>
              Move down
            </Menu.Item>
            <Menu.Item disabled={!canReorder || index >= last} onClick={() => reorderTo(last + 1, null)}>
              Move to bottom
            </Menu.Item>
            <Menu.Divider />
          </>
        )}
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
        {ticket.state.column === 'review' && ticket.branch !== null && (
          <Menu.Item disabled={moving} onClick={() => onMerge(ticket)}>
            Merge…
          </Menu.Item>
        )}
        {ticket.state.column === 'done' && (
          <Menu.Item disabled={moving} onClick={() => onArchive(ticket)}>
            Archive
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  )
})
