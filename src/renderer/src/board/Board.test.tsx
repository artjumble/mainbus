import type { DragEndEvent } from '@dnd-kit/core'
import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, makeLineup, makeTicket, renderWithMantine, workspace } from '../test-utils'
import { Board, gridStyle } from './Board'

// Capture the drag handler so a test can call it the way dnd-kit would.
let onDragEnd: (e: DragEndEvent) => void = () => {}
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>()
  return {
    ...actual,
    DndContext: (props: { onDragEnd?: (e: DragEndEvent) => void; children?: React.ReactNode }) => {
      onDragEnd = props.onDragEnd ?? (() => {})
      return <>{props.children}</>
    }
  }
})
vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
/** The commands sent so far, not counting the header's read of the branches (it runs whenever a board shows). */
const calls = (): unknown[][] => mockInvoke.mock.calls.filter(([command]) => command !== 'workspace.branches')
const initial = useMainbus.getState()

function drag(id: string, overId: string | null): void {
  const event = { active: { id }, over: overId === null ? null : { id: overId } } as unknown as DragEndEvent
  act(() => onDragEnd(event))
}

beforeEach(() => {
  mockInvoke.mockReset()
  mockInvoke.mockResolvedValue({ tickets: [] })
})

function showBoard(...tickets: ReturnType<typeof makeTicket>[]): void {
  useMainbus.setState({ ...initial, workspace, workspaceLoaded: true, tickets }, true)
}

test('Board renders six columns in order with counts', () => {
  showBoard(
    makeTicket({}, { column: 'backlog' }),
    makeTicket({}, { column: 'backlog' }),
    makeTicket({}, { column: 'ready' }),
    makeTicket({}, { column: 'review', phase: 'ready_for_review' })
  )
  renderWithMantine(<Board />)

  const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
  expect(headings).toEqual(['Backlog', 'Ready', 'In progress', 'Needs you', 'Review', 'Done'])

  const counts = ['Backlog', 'Ready', 'In progress', 'Needs you, no tickets', 'Review', 'Done'].map((name) =>
    within(screen.getByRole('region', { name })).getByTestId('column-count').textContent
  )
  expect(counts).toEqual(['2', '1', '0', '0', '1', '0'])
})

test('clicking a card opens that ticket', async () => {
  const ticket = makeTicket({ title: 'Open me' })
  showBoard(ticket)
  renderWithMantine(<Board />)
  await userEvent.click(screen.getByRole('button', { name: /Open me/ }))
  expect(useMainbus.getState().currentTicketId).toBe(ticket.id)
})

test('dragging a card from Backlog to Ready calls ticket.move', async () => {
  const ticket = makeTicket({}, { column: 'backlog' })
  showBoard(ticket)
  renderWithMantine(<Board />)
  drag(ticket.id, 'ready')
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ticket.move', ticket.id, 'ready'))
})

test('a drop on a column that takes no manual drops, or on nothing, moves nothing', () => {
  const ticket = makeTicket({}, { column: 'backlog' })
  showBoard(ticket)
  renderWithMantine(<Board />)
  drag(ticket.id, 'needs_you')
  drag(ticket.id, 'review')
  drag(ticket.id, null)
  drag(ticket.id, 'backlog') // already there
  expect(calls()).toEqual([])
})

test.each(['backlog', 'ready'] as const)('dragging a %s card into In progress proposes a start and leaves the card where it is', async (column) => {
  const ticket = makeTicket({}, { column })
  showBoard(ticket)
  mockInvoke.mockResolvedValue({ id: 'p1' })
  renderWithMantine(<Board />)
  drag(ticket.id, 'in_progress')
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ticket.proposeStart', ticket.id))
  expect(mockInvoke).not.toHaveBeenCalledWith('ticket.move', expect.anything(), expect.anything())
  await vi.waitFor(() => expect(useMainbus.getState().revealedProposal).toEqual({ id: 'p1', n: 1 }))
  expect(useMainbus.getState().pendingMoves).toEqual({})
  expect(within(screen.getByRole('region', { name: column === 'backlog' ? 'Backlog' : 'Ready' })).getByRole('button', { name: /^Ticket/ })).toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: 'In progress' })).getByTestId('column-count').textContent).toBe('0')
})

test.each(['review', 'needs_you', 'in_progress'] as const)('dragging a %s card into In progress does nothing', (column) => {
  const ticket = makeTicket({}, column === 'review' ? { column, phase: 'ready_for_review' } : { column })
  showBoard(ticket)
  renderWithMantine(<Board />)
  drag(ticket.id, 'in_progress')
  expect(calls()).toEqual([])
})

test('an engine refusal of the start proposal shows a notification', async () => {
  const ticket = makeTicket({}, { column: 'backlog' })
  showBoard(ticket)
  mockInvoke.mockRejectedValue(new Error('ticket: #1 is already running'))
  renderWithMantine(<Board />)
  drag(ticket.id, 'in_progress')
  expect(await screen.findByText(/already running/)).toBeInTheDocument()
  expect(useMainbus.getState().revealedProposal).toBeNull()
})

test('moving a ticket with uncommitted work to Done shows a notification', async () => {
  const ticket = makeTicket({}, { column: 'review', phase: 'ready_for_review' })
  showBoard(ticket)
  mockInvoke.mockResolvedValue('dirty')
  renderWithMantine(<Board />)
  drag(ticket.id, 'done')
  expect(
    await screen.findByText(
      'This ticket has uncommitted changes in its folder. Ask the Implementer to commit them first.'
    )
  ).toBeInTheDocument()
  // Nothing moved: the card is still in Review.
  expect(within(screen.getByRole('region', { name: 'Review' })).getByText(ticket.title)).toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: 'Done' })).queryByText(ticket.title)).not.toBeInTheDocument()
})

test('moving a ticket whose folder needs a decision to Done tells the user to answer it', async () => {
  const ticket = makeTicket({}, { column: 'review', phase: 'ready_for_review' })
  showBoard(ticket)
  mockInvoke.mockResolvedValue('asked')
  renderWithMantine(<Board />)
  drag(ticket.id, 'done')
  expect(
    await screen.findByText("This ticket's folder is no longer a git worktree. Open the ticket to decide whether to delete it.")
  ).toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: 'Review' })).getByText(ticket.title)).toBeInTheDocument()
})

test('a rejected move shows the engine message', async () => {
  const ticket = makeTicket({}, { column: 'backlog' })
  showBoard(ticket)
  mockInvoke.mockRejectedValue(new Error("Error invoking remote method 'engine:invoke': Error: ticket has an open run"))
  renderWithMantine(<Board />)
  drag(ticket.id, 'ready')
  expect(await screen.findByText('ticket has an open run')).toBeInTheDocument()
})

test('a successful move refreshes the board', async () => {
  const ticket = makeTicket({}, { column: 'backlog' })
  showBoard(ticket)
  mockInvoke.mockImplementation(async (command: string) => (command === 'ticket.move' ? 'moved' : { tickets: [] }))
  renderWithMantine(<Board />)
  drag(ticket.id, 'ready')
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('board.get'))
})

describe('a move shows at once', () => {
  /** A `ticket.move` that answers only when the test says so, like a worktree removal that takes seconds. */
  function slowMove(board: () => ReturnType<typeof makeTicket>[]): {
    settle: (answer: 'moved' | 'dirty' | Error) => Promise<void>
  } {
    let answer: (value: 'moved' | 'dirty' | Error) => void = () => {}
    const pending = new Promise<'moved' | 'dirty' | Error>((resolve) => {
      answer = resolve
    })
    mockInvoke.mockImplementation(async (command: string) => {
      if (command !== 'ticket.move') return { tickets: board() }
      const value = await pending
      if (value instanceof Error) throw value
      return value
    })
    return {
      settle: async (value) => {
        await act(async () => {
          answer(value)
          await pending
        })
      }
    }
  }

  const column = (name: string): HTMLElement => screen.getByRole('region', { name })

  test('a Review card dropped on Done shows in Done, cleaning up, before the engine answers', async () => {
    const ticket = makeTicket({ title: 'Ship me' }, { column: 'review', phase: 'ready_for_review' })
    let engineBoard = [ticket]
    showBoard(ticket)
    const move = slowMove(() => engineBoard)
    renderWithMantine(<Board />)

    drag(ticket.id, 'done')
    expect(within(column('Done')).getByText('Ship me')).toBeInTheDocument()
    expect(within(column('Review')).queryByText('Ship me')).not.toBeInTheDocument()
    expect(within(column('Done')).getByText('Cleaning up…')).toBeInTheDocument()

    // A refresh while the engine still says Review (a board.changed, say) does not put the card back.
    await act(() => useMainbus.getState().refreshBoard())
    expect(within(column('Done')).getByText('Ship me')).toBeInTheDocument()

    // Once the engine moved it, the board agrees and the marker goes.
    engineBoard = [{ ...ticket, manualColumn: 'done', state: { ...ticket.state, column: 'done', phase: 'done' } }]
    await move.settle('moved')
    await vi.waitFor(() => expect(within(column('Done')).queryByText('Cleaning up…')).not.toBeInTheDocument())
    expect(within(column('Done')).getByText('Ship me')).toBeInTheDocument()
    expect(useMainbus.getState().pendingMoves).toEqual({})
  })

  test('a card being moved cannot be moved again until the engine answers', async () => {
    const ticket = makeTicket({ title: 'Ship me' }, { column: 'review', phase: 'ready_for_review' })
    showBoard(ticket)
    slowMove(() => [ticket])
    renderWithMantine(<Board />)

    drag(ticket.id, 'done')
    drag(ticket.id, 'backlog')
    expect(calls()).toHaveLength(1)

    // The card is in Done now, whose cards show while it is open.
    act(() => column('Done').focus())
    screen.getByRole('button', { name: /Ship me/ }).focus()
    await userEvent.keyboard('{Shift>}{F10}{/Shift}')
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })

  test('a dirty worktree sends the card back to Review with the notice', async () => {
    const ticket = makeTicket({ title: 'Ship me' }, { column: 'review', phase: 'ready_for_review' })
    showBoard(ticket)
    const move = slowMove(() => [ticket])
    renderWithMantine(<Board />)

    drag(ticket.id, 'done')
    expect(within(column('Done')).getByText('Ship me')).toBeInTheDocument()
    await move.settle('dirty')
    expect(await screen.findByText("Can't move this ticket yet")).toBeInTheDocument()
    expect(within(column('Review')).getByText('Ship me')).toBeInTheDocument()
    expect(within(column('Done')).queryByText('Ship me')).not.toBeInTheDocument()
  })

  test('a refused move sends the card back with the engine message', async () => {
    const ticket = makeTicket({ title: 'Ship me' }, { column: 'review', phase: 'ready_for_review' })
    showBoard(ticket)
    const move = slowMove(() => [ticket])
    renderWithMantine(<Board />)

    drag(ticket.id, 'done')
    expect(within(column('Done')).getByText('Ship me')).toBeInTheDocument()
    await move.settle(new Error("Error invoking remote method 'engine:invoke': Error: The agent is still working on this ticket; stop it first"))
    expect(await screen.findByText('The agent is still working on this ticket; stop it first')).toBeInTheDocument()
    expect(within(column('Review')).getByText('Ship me')).toBeInTheDocument()
    expect(within(column('Done')).queryByText('Ship me')).not.toBeInTheDocument()
  })

  test.each([
    ['backlog', 'Backlog', 'ready', 'Ready'],
    ['ready', 'Ready', 'backlog', 'Backlog']
  ] as const)('a move from %s to %s shows at once too, without the cleanup marker', async (from, fromTitle, to, toTitle) => {
    const ticket = makeTicket({ title: 'Plan me' }, { column: from })
    showBoard(ticket)
    slowMove(() => [ticket])
    renderWithMantine(<Board />)

    drag(ticket.id, to)
    expect(within(column(toTitle)).getByText('Plan me')).toBeInTheDocument()
    expect(within(column(fromTitle)).queryByText('Plan me')).not.toBeInTheDocument()
    expect(screen.queryByText('Cleaning up…')).not.toBeInTheDocument()
  })

  test('the card menu moves optimistically too', async () => {
    const ticket = makeTicket({ title: 'Menu me' }, { column: 'review', phase: 'ready_for_review' })
    showBoard(ticket)
    slowMove(() => [ticket])
    renderWithMantine(<Board />)
    screen.getByRole('button', { name: /Menu me/ }).focus()
    await userEvent.keyboard('{Shift>}{F10}{/Shift}')
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to Done' }))
    expect(within(column('Done')).getByText('Menu me')).toBeInTheDocument()
    expect(within(column('Done')).getByText('Cleaning up…')).toBeInTheDocument()
  })
})

describe('moving a card without dragging', () => {
  test('a Backlog card menu offers Move to In progress…, which proposes a start', async () => {
    const ticket = makeTicket({ title: 'Menu me' }, { column: 'backlog' })
    showBoard(ticket)
    mockInvoke.mockResolvedValue({ id: 'p1' })
    renderWithMantine(<Board />)
    screen.getByRole('button', { name: /Menu me/ }).focus()
    await userEvent.keyboard('{Shift>}{F10}{/Shift}')
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to In progress…' }))
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ticket.proposeStart', ticket.id))
    expect(mockInvoke).not.toHaveBeenCalledWith('ticket.move', expect.anything(), expect.anything())
  })

  test('Shift+F10 on a focused card opens a menu, and Done moves the ticket', async () => {
    const ticket = makeTicket({ title: 'Menu me' }, { column: 'review', phase: 'ready_for_review' })
    showBoard(ticket)
    mockInvoke.mockImplementation(async (command: string) => (command === 'ticket.move' ? 'moved' : { tickets: [ticket] }))
    renderWithMantine(<Board />)
    screen.getByRole('button', { name: /Menu me/ }).focus()
    await userEvent.keyboard('{Shift>}{F10}{/Shift}')
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to Done' }))
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ticket.move', ticket.id, 'done'))
  })

  test.each([['Escape', '{Escape}'], ['choosing an item', null]])('focus goes back to the card after the menu closes by %s', async (_how, key) => {
    const ticket = makeTicket({ title: 'Menu me' })
    showBoard(ticket)
    mockInvoke.mockImplementation(async (command: string) => (command === 'ticket.move' ? 'moved' : { tickets: [ticket] }))
    renderWithMantine(<Board />)
    const title = screen.getByRole('button', { name: /Menu me/ })
    title.focus()
    await userEvent.keyboard('{Shift>}{F10}{/Shift}')
    const item = await screen.findByRole('menuitem', { name: 'Move to Ready' })
    if (key) await userEvent.keyboard(key)
    else await userEvent.click(item)
    // The card may have moved column, which makes it a new element.
    await vi.waitFor(() => expect(screen.getByRole('button', { name: /Menu me/ })).toHaveFocus())
  })

  test('the context-menu key and a right-click open it too', async () => {
    const ticket = makeTicket({ title: 'Menu me' })
    showBoard(ticket)
    renderWithMantine(<Board />)
    const card = screen.getByRole('button', { name: /Menu me/ })
    card.focus()
    await userEvent.keyboard('{ContextMenu}')
    expect(await screen.findByRole('menuitem', { name: 'Move to Ready' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await vi.waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Move to Ready' })).not.toBeInTheDocument())
    await userEvent.pointer({ keys: '[MouseRight]', target: card })
    expect(await screen.findByRole('menuitem', { name: 'Move to Ready' })).toBeInTheDocument()
  })

  test('the menu offers Backlog, Ready and Done, minus where the card already is', async () => {
    showBoard(makeTicket({ title: 'Menu me' }, { column: 'ready' }))
    renderWithMantine(<Board />)
    screen.getByRole('button', { name: /Menu me/ }).focus()
    await userEvent.keyboard('{Shift>}{F10}{/Shift}')
    expect(await screen.findByRole('menuitem', { name: 'Move to Backlog' })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: 'Move to Done' })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: 'Move to Ready' })).toBeDisabled()
  })

  test('a plain click still opens the ticket and does not open the menu', async () => {
    const ticket = makeTicket({ title: 'Menu me' })
    showBoard(ticket)
    renderWithMantine(<Board />)
    await userEvent.click(screen.getByRole('button', { name: /Menu me/ }))
    expect(useMainbus.getState().currentTicketId).toBe(ticket.id)
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })
})

test('the settings button in the header asks for the workspace settings', async () => {
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'lineup.get') return makeLineup()
    if (command === 'allowRules.list') return []
    if (command === 'agents.launcher') return null
    return { tickets: [] }
  })
  showBoard()
  // The drawer itself lives in the app shell, so Settings also works from the ticket view.
  renderWithMantine(<Board />)
  await userEvent.click(screen.getByRole('button', { name: 'Workspace settings' }))
  expect(useMainbus.getState().settingsOpen).toBe(true)
})

function searchBox(): HTMLElement {
  return screen.getByRole('textbox', { name: 'Search tickets' })
}

describe('search', () => {
  function showSearchable(): void {
    const login = makeTicket(
      { number: 12, title: 'Fix login', labels: ['auth'], intent: [{ text: 'Users cannot sign in', at: '2026-10-30T00:00:00.000Z' }] },
      { column: 'backlog' }
    )
    const docs = makeTicket(
      { number: 34, title: 'Add docs', labels: ['writing'], intent: [{ text: 'Explain the setup', at: '2026-10-30T00:00:00.000Z' }] },
      { column: 'ready' }
    )
    showBoard(login, docs)
  }

  test.each([
    ['#12', 'Fix login'],
    ['12', 'Fix login'],
    ['docs', 'Add docs'],
    ['AUTH', 'Fix login'],
    ['writing', 'Add docs'],
    ['sign in', 'Fix login'],
    ['setup', 'Add docs']
  ])('typing %s shows only %s', async (query, title) => {
    showSearchable()
    renderWithMantine(<Board />)
    await userEvent.type(searchBox(), query)
    const other = title === 'Fix login' ? 'Add docs' : 'Fix login'
    expect(screen.getByRole('button', { name: new RegExp(title) })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: new RegExp(other) })).not.toBeInTheDocument()
  })

  test('columns keep their order and empty ones say No matches; the count follows the filter', async () => {
    showSearchable()
    renderWithMantine(<Board />)
    await userEvent.type(searchBox(), 'docs')
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Backlog',
      'Ready',
      'In progress',
      'Needs you',
      'Review',
      'Done'
    ])
    expect(within(screen.getByRole('region', { name: 'Backlog' })).getByText('No matches')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Backlog' })).getByTestId('column-count')).toHaveTextContent('0')
    expect(within(screen.getByRole('region', { name: 'Ready' })).getByTestId('column-count')).toHaveTextContent('1')
    // Needs you, with no tickets at all, is a strip with no placeholder.
    expect(screen.getAllByText('No matches')).toHaveLength(4)
  })

  test('the clear button and Escape reset the filter', async () => {
    showSearchable()
    renderWithMantine(<Board />)
    await userEvent.type(searchBox(), 'docs')
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(searchBox()).toHaveValue('')
    expect(screen.getByRole('button', { name: /Fix login/ })).toBeInTheDocument()

    await userEvent.type(searchBox(), 'docs{Escape}')
    expect(searchBox()).toHaveValue('')
    expect(screen.queryByText('No matches')).not.toBeInTheDocument()
  })

  test('Ctrl+K and / focus the box when no input has focus, and / is not typed into it', async () => {
    showSearchable()
    renderWithMantine(<Board />)
    await userEvent.keyboard('{Control>}k{/Control}')
    expect(searchBox()).toHaveFocus()
    searchBox().blur()
    await userEvent.keyboard('/')
    expect(searchBox()).toHaveFocus()
    expect(searchBox()).toHaveValue('')
  })

  test('/ does not steal focus from another input', async () => {
    showSearchable()
    renderWithMantine(
      <>
        <Board />
        <textarea aria-label="Other" />
      </>
    )
    await userEvent.click(screen.getByRole('textbox', { name: 'Other' }))
    await userEvent.keyboard('a/b')
    expect(screen.getByRole('textbox', { name: 'Other' })).toHaveValue('a/b')
    expect(searchBox()).not.toHaveFocus()
  })

  test('the filter resets when the focused workspace changes', async () => {
    showSearchable()
    useMainbus.setState({ search: 'docs' })
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'workspace.get') return { ...workspace, id: 'other' }
      if (command === 'board.get') return { tickets: [] }
      return { on: false, status: { kind: 'off' } }
    })
    await act(() => useMainbus.getState().reloadFocused())
    expect(useMainbus.getState().search).toBe('')
  })
})

describe('lanes', () => {
  const lanes = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-lane]')]

  /** jsdom has no layout: what makes a lane full height is the layout's styles, checked here; the e2e measures it. */
  function expectFullHeight(board: HTMLElement): void {
    expect(board.style.display).toBe('grid')
    expect(board.style.alignItems).toBe('stretch')
    // The board grows to the height left under the header, and grows past it with its cards; it never shrinks.
    expect(board.style.flex).toBe('1 0 auto')
    expect(board.parentElement!.style.flex).toBe('1 0 auto')
    for (const lane of lanes()) {
      expect(lane.style.minHeight).toBe('')
      expect(lane.style.height).toBe('')
      expect(lane.style.alignSelf).toBe('')
    }
  }

  test('every lane, the strips too, stretches to the board, which fills the height left and grows with its cards', () => {
    showBoard(makeTicket({}, { column: 'backlog' }))
    renderWithMantine(<Board />)
    expect(lanes().map((l) => l.getAttribute('aria-label') ?? l.getAttribute('aria-labelledby'))).toEqual([
      'column-backlog',
      'column-ready',
      'column-in_progress',
      'Needs you, no tickets',
      'column-review',
      'column-done'
    ])
    expectFullHeight(lanes()[0].parentElement!)
    // No scrolling inside a lane: the board scrolls.
    for (const lane of lanes()) expect(lane.style.overflowY).toBe('')
  })

  test('lanes have no outline and square corners, a fill of their own, while cards keep their border and shadow', () => {
    showBoard(
      makeTicket({ title: 'Plain' }, { column: 'backlog' }),
      makeTicket({ title: 'Waiting' }, { column: 'needs_you', phase: 'waiting_on_you', agentStatus: 'waiting_on_you' })
    )
    renderWithMantine(<Board />)
    for (const lane of lanes()) {
      expect(lane).not.toHaveAttribute('data-with-border')
      expect(lane.style.border).toBe('')
      expect(lane.style.borderTop).toBe('')
      expect(lane.style.borderBottom).toBe('')
      expect(lane.style.getPropertyValue('--paper-radius')).toMatch(/^0(px|rem)?$/)
    }
    const fill = (name: string): string => screen.getByRole('region', { name }).style.background
    for (const name of ['Backlog', 'Ready', 'In progress', 'Review', 'Done']) expect(fill(name)).toContain('--mainbus-color-lane')
    // The Needs you tint.
    expect(fill('Needs you')).toContain('--mantine-color-needs-0')

    const card = (title: string): HTMLElement => screen.getByRole('button', { name: title }).closest<HTMLElement>('.mantine-Paper-root')!
    for (const title of ['Plain', 'Waiting']) {
      expect(card(title)).toHaveAttribute('data-with-border')
      expect(card(title).style.getPropertyValue('--paper-shadow')).not.toBe('')
    }
    expect(card('Plain').style.border).toContain('--mainbus-color-card-border')
    expect(card('Waiting').style.border).toContain('--mantine-color-needs-6')
  })

  test('Done open over Review keeps its shadow and gets a line at its edge, with still no top or bottom border', () => {
    showBoard(makeTicket({}, { column: 'done', phase: 'done' }))
    renderWithMantine(<Board />)
    const done = screen.getByRole('region', { name: 'Done' })
    expect(done.style.borderLeft).toBe('')
    act(() => done.focus())
    expect(done).toHaveAttribute('data-expanded', 'true')
    expect(done.style.boxShadow).toContain('--mantine-shadow-md')
    expect(done.style.borderLeft).toContain('--mainbus-color-card-border')
    expect(done.style.borderTop).toBe('')
    expect(done.style.borderBottom).toBe('')
  })

  test("the empty board's placeholder lanes are full height too, with the lanes' look, and the message lies over them", () => {
    useMainbus.setState({ ...initial, workspace, workspaceLoaded: true, boardLoaded: true, tickets: [] }, true)
    renderWithMantine(<Board />)
    expect(lanes()).toHaveLength(6)
    expectFullHeight(lanes()[0].parentElement!)
    for (const lane of lanes()) {
      expect(lane).not.toHaveAttribute('data-with-border')
      expect(lane.style.border).toBe('')
    }
    expect(screen.getByText(/No tickets in .* yet/).closest('.mantine-Paper-root')).toHaveAttribute('data-with-border')
  })

  test('the empty board has the real board\'s tracks and fills: Needs you the tinted collapsed strip, Done the strip', () => {
    showBoard(makeTicket({}, { column: 'backlog' }))
    const real = renderWithMantine(<Board />)
    const realLanes = lanes()
    const realTracks = realLanes[0].parentElement!.style.gridTemplateColumns
    const realFills = realLanes.map((l) => l.style.background)
    expect(realTracks).toBe(gridStyle(true).gridTemplateColumns)
    real.unmount()

    useMainbus.setState({ ...initial, workspace, workspaceLoaded: true, boardLoaded: true, tickets: [] }, true)
    renderWithMantine(<Board />)
    const empty = lanes()
    expect(empty[0].parentElement!.style.gridTemplateColumns).toBe(realTracks)
    expect(empty.map((l) => l.style.background)).toEqual(realFills)
    expect(empty[3]).toHaveAttribute('data-collapsed')
    expect(empty[3].style.background).toContain('--mantine-color-needs-0')
    expect(empty.filter((l) => l.hasAttribute('data-collapsed'))).toHaveLength(1)
    expect(empty[5].querySelector('h3')!.style.writingMode).toBe('vertical-rl')
  })
})

describe('empty states', () => {
  test('a workspace with no tickets shows No tickets yet with both actions and no header New ticket', async () => {
    useMainbus.setState({ ...initial, workspace, workspaceLoaded: true, boardLoaded: true, tickets: [] }, true)
    renderWithMantine(<Board />)
    expect(screen.getByText(/No tickets in .* yet/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'New ticket' })).toHaveLength(1)
    expect(screen.queryByRole('textbox', { name: 'Search tickets' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Ask orchestrator to draft tickets' }))
    expect(useMainbus.getState().orchestratorPrefill?.text).toBe('Draft tickets for ')

    await userEvent.click(screen.getByRole('button', { name: 'New ticket' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  test('the empty state waits for the first board read', () => {
    useMainbus.setState({ ...initial, workspace, workspaceLoaded: true, tickets: [] }, true)
    renderWithMantine(<Board />)
    expect(screen.queryByText(/No tickets in .* yet/)).not.toBeInTheDocument()
  })

  test('an empty column has a quiet placeholder', () => {
    showBoard(makeTicket({}, { column: 'backlog' }))
    renderWithMantine(<Board />)
    expect(within(screen.getByRole('region', { name: 'Done' })).getByText('Nothing here')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Backlog' })).queryByText('Nothing here')).not.toBeInTheDocument()
  })
})

describe('the Done column', () => {
  const done = (): HTMLElement => screen.getByRole('region', { name: 'Done' })
  const expanded = (): string | null => done().getAttribute('data-expanded')
  const count = (): string | null => within(done()).getByTestId('column-count').textContent
  const shipped = (title: string): ReturnType<typeof makeTicket> =>
    makeTicket({ title }, { column: 'done', phase: 'done' })

  const realMatchMedia = window.matchMedia
  afterEach(() => {
    window.matchMedia = realMatchMedia
    vi.useRealTimers()
  })

  test('is a closed strip by default, with its title and count, and the count follows a search', async () => {
    showBoard(shipped('Old work'), shipped('Older work'), makeTicket({ title: 'Fresh' }, { column: 'backlog' }))
    renderWithMantine(<Board />)
    expect(expanded()).toBe('false')
    expect(within(done()).getByRole('heading', { level: 3, name: 'Done' })).toBeInTheDocument()
    expect(count()).toBe('2')
    expect(done()).toHaveAccessibleDescription('2 tickets')
    await userEvent.type(screen.getByRole('textbox', { name: 'Search tickets' }), 'Older')
    expect(count()).toBe('1')
    expect(done()).toHaveAccessibleDescription('1 ticket')
  })

  test('opens after a short hover and closes a little after the pointer leaves', () => {
    vi.useFakeTimers()
    showBoard(shipped('Old work'))
    renderWithMantine(<Board />)
    fireEvent.pointerEnter(done())
    act(() => void vi.advanceTimersByTime(100))
    expect(expanded()).toBe('false')
    act(() => void vi.advanceTimersByTime(60))
    expect(expanded()).toBe('true')
    expect(screen.getByRole('button', { name: /Old work/ })).toBeVisible()

    fireEvent.pointerLeave(done())
    act(() => void vi.advanceTimersByTime(250))
    expect(expanded()).toBe('true')
    act(() => void vi.advanceTimersByTime(60))
    expect(expanded()).toBe('false')
  })

  test('passing over it does not open it', () => {
    vi.useFakeTimers()
    showBoard(shipped('Old work'))
    renderWithMantine(<Board />)
    fireEvent.pointerEnter(done())
    act(() => void vi.advanceTimersByTime(100))
    fireEvent.pointerLeave(done())
    act(() => void vi.advanceTimersByTime(1000))
    expect(expanded()).toBe('false')
  })

  test('opens at once on focus, its cards are then in the tab order, and it closes after focus leaves', async () => {
    showBoard(shipped('Old work'))
    renderWithMantine(<Board />)
    act(() => done().focus())
    expect(expanded()).toBe('true')
    expect(screen.getByRole('button', { name: /Old work/ })).toBeVisible()
    await userEvent.tab()
    expect(document.activeElement).not.toBe(done())
    expect(done()).toContainElement(document.activeElement as HTMLElement)

    act(() => screen.getByRole('textbox', { name: 'Search tickets' }).focus())
    expect(expanded()).toBe('true')
    await vi.waitFor(() => expect(expanded()).toBe('false'))
  })

  test('closed, its cards are hidden from sight, the tab order and screen readers', async () => {
    const review = makeTicket({ title: 'Look at me' }, { column: 'review', phase: 'ready_for_review' })
    showBoard(review, shipped('Old work'))
    renderWithMantine(<Board />)
    const card = screen.getByText('Old work')
    expect(card).not.toBeVisible()
    expect(card.closest('[inert]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /Old work/ })).not.toBeInTheDocument()
    // Tab out of Review (its card's title is its last stop) lands on the strip itself, not on a card in it.
    screen.getByRole('button', { name: /Look at me/ }).focus()
    await userEvent.tab()
    expect(done()).toHaveFocus()
  })

  test('shows a working indicator while a move to Done is cleaning up, gone when the engine answers', async () => {
    for (const answer of ['moved', 'dirty'] as const) {
      const ticket = makeTicket({ title: 'Ship me' }, { column: 'review', phase: 'ready_for_review' })
      showBoard(ticket)
      let settle: (value: string) => void = () => {}
      mockInvoke.mockImplementation((command: string) =>
        command === 'ticket.move' ? new Promise((resolve) => (settle = resolve)) : Promise.resolve({ tickets: [ticket] })
      )
      const { unmount } = renderWithMantine(<Board />)
      expect(within(done()).queryByTestId('done-working')).not.toBeInTheDocument()
      drag(ticket.id, 'done')
      expect(within(done()).getByTestId('done-working')).toHaveTextContent('Cleaning up')
      await act(async () => settle(answer))
      await vi.waitFor(() => expect(within(done()).queryByTestId('done-working')).not.toBeInTheDocument())
      unmount()
    }
  })

  test('Move to Done from the card menu leaves focus on the card, in Done opened', async () => {
    const ticket = makeTicket({ title: 'Menu me' }, { column: 'review', phase: 'ready_for_review' })
    showBoard(ticket)
    mockInvoke.mockImplementation((command: string) => (command === 'ticket.move' ? new Promise(() => {}) : Promise.resolve({ tickets: [ticket] })))
    renderWithMantine(<Board />)
    screen.getByRole('button', { name: /Menu me/ }).focus()
    await userEvent.keyboard('{Shift>}{F10}{/Shift}')
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to Done' }))
    await vi.waitFor(() => expect(within(done()).getByRole('button', { name: /Menu me/ })).toHaveFocus())
    expect(expanded()).toBe('true')
  })

  test.each([
    [false, /width 150ms/],
    [true, /^none$/]
  ])('with reduced motion %s, the transition is %s', (reduce, transition) => {
    window.matchMedia = ((query: string) => ({
      matches: reduce && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null
    })) as unknown as typeof window.matchMedia
    showBoard(shipped('Old work'))
    renderWithMantine(<Board />)
    expect(done().style.transition).toMatch(transition)
    act(() => done().focus())
    expect(expanded()).toBe('true')
    expect(done().style.transition).toMatch(transition)
  })

  test('has no axe violations, closed or open', async () => {
    showBoard(shipped('Old work'), makeTicket({}, { column: 'backlog' }))
    renderWithMantine(<Board />)
    await expectNoAxeViolations()
    act(() => done().focus())
    expect(expanded()).toBe('true')
    await expectNoAxeViolations()
  })
})

describe('the Needs you column', () => {
  const strip = (): HTMLElement => screen.getByRole('region', { name: 'Needs you, no tickets' })
  const full = (): HTMLElement => screen.getByRole('region', { name: 'Needs you' })
  const board = (): HTMLElement => full().parentElement!
  const waiting = (title: string): ReturnType<typeof makeTicket> =>
    makeTicket({ title }, { column: 'needs_you', phase: 'waiting_on_you', agentStatus: 'waiting_on_you' })

  const realMatchMedia = window.matchMedia
  afterEach(() => {
    window.matchMedia = realMatchMedia
  })

  test('is a strip while empty, with its heading, a count of 0 and no placeholder, and the grid gives it a strip track', () => {
    showBoard(makeTicket({}, { column: 'backlog' }))
    renderWithMantine(<Board />)
    expect(strip()).toHaveAttribute('data-collapsed')
    expect(within(strip()).getByRole('heading', { level: 3, name: 'Needs you' })).toBeInTheDocument()
    expect(within(strip()).getByTestId('column-count')).toHaveTextContent('0')
    expect(within(strip()).queryByText('Nothing here')).not.toBeInTheDocument()
    expect(strip().parentElement!.style.gridTemplateColumns).toBe(gridStyle(true).gridTemplateColumns)
  })

  test('opens to a full column when a ticket arrives, and collapses again when the last one leaves', () => {
    const backlog = makeTicket({}, { column: 'backlog' })
    showBoard(backlog)
    renderWithMantine(<Board />)
    expect(strip()).toBeInTheDocument()

    const arriving = waiting('Which database?')
    act(() => useMainbus.setState({ tickets: [backlog, arriving], recentlyChanged: { [arriving.id]: Date.now() } }))
    expect(screen.queryByRole('region', { name: 'Needs you, no tickets' })).not.toBeInTheDocument()
    // The arriving card has the usual recently-changed outline.
    expect(full().querySelector('[data-recently-changed]')).not.toBeNull()
    expect(full()).not.toHaveAttribute('data-collapsed')
    expect(within(full()).getByText('Which database?')).toBeInTheDocument()
    expect(within(full()).getByTestId('column-count')).toHaveTextContent('1')
    expect(board().style.gridTemplateColumns).toBe(gridStyle(false).gridTemplateColumns)

    act(() => useMainbus.setState({ tickets: [backlog] }))
    expect(strip()).toHaveAttribute('data-collapsed')
    expect(strip().parentElement!.style.gridTemplateColumns).toBe(gridStyle(true).gridTemplateColumns)
  })

  test('stays full while a search matches none of its tickets, saying No matches', async () => {
    showBoard(waiting('Which database?'), makeTicket({ title: 'Add docs' }, { column: 'backlog' }))
    renderWithMantine(<Board />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Search tickets' }), 'docs')
    expect(full()).not.toHaveAttribute('data-collapsed')
    expect(within(full()).getByText('No matches')).toBeInTheDocument()
    expect(within(full()).getByTestId('column-count')).toHaveTextContent('0')
  })

  test.each([true, false])('with Needs you collapsed %s, Done opens to exactly one full column', (collapsed) => {
    const style = gridStyle(collapsed) as Record<string, string>
    const fullTracks = (style['gridTemplateColumns']!.match(/minmax\(120px, 1fr\)/g) ?? []).length
    const strips = 6 - fullTracks
    expect(fullTracks).toBe(collapsed ? 4 : 5)
    // Evaluated for a 1440 px board with 12 px gaps and the 44 px strip.
    const [width, gap, stripWidth] = [1440, 12, 44]
    const expr = style['--column-width']!
      .replace(/^max\(120px, calc\((.*)\)\)$/, '$1')
      .replaceAll('100cqw', String(width))
      .replaceAll('var(--strip)', String(stripWidth))
      .replaceAll('var(--mantine-spacing-sm)', String(gap))
    expect(expr).toMatch(/^[\d\s()*/+-]+$/)
    const doneOpen = Number(new Function(`return ${expr}`)())
    // Each full track's share of what the strips and the gaps leave.
    expect(doneOpen).toBeCloseTo((width - strips * stripWidth - 5 * gap) / fullTracks)
    expect(style['--strip']).toBe(`${stripWidth}px`)
  })

  test.each([
    [false, /grid-template-columns 150ms/],
    [true, /^none$/]
  ])('with reduced motion %s, the width change is %s', (reduce, transition) => {
    window.matchMedia = ((query: string) => ({
      matches: reduce && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null
    })) as unknown as typeof window.matchMedia
    showBoard(makeTicket({}, { column: 'backlog' }))
    renderWithMantine(<Board />)
    expect(strip().parentElement!.style.transition).toMatch(transition)
  })

  test('has no axe violations, as a strip or full', async () => {
    const backlog = makeTicket({}, { column: 'backlog' })
    showBoard(backlog)
    renderWithMantine(<Board />)
    expect(strip()).toBeInTheDocument()
    await expectNoAxeViolations()
    act(() => useMainbus.setState({ tickets: [backlog, waiting('Which database?')] }))
    expect(full()).toBeInTheDocument()
    await expectNoAxeViolations()
  })
})

describe('accessibility', () => {
  test('a board with cards in every column has no axe violations', async () => {
    showBoard(
      makeTicket({}, { column: 'backlog' }),
      makeTicket({}, { column: 'ready' }),
      makeTicket({}, { column: 'in_progress', phase: 'implementing', agentStatus: 'working' }),
      makeTicket({}, { column: 'review', phase: 'ready_for_review' }),
      makeTicket({}, { column: 'done', phase: 'done' })
    )
    renderWithMantine(<Board />)
    await expectNoAxeViolations()
  })

  test('the empty board, no matches and the New ticket modal have no axe violations', async () => {
    useMainbus.setState({ ...initial, workspace, workspaceLoaded: true, boardLoaded: true, tickets: [] }, true)
    const { unmount } = renderWithMantine(<Board />)
    await expectNoAxeViolations()
    await userEvent.click(screen.getAllByRole('button', { name: 'New ticket' })[0]!)
    await expectNoAxeViolations()
    unmount()

    showBoard(makeTicket({ title: 'Alpha' }))
    renderWithMantine(<Board />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Search tickets' }), 'zzz')
    expect(screen.getAllByText('No matches').length).toBeGreaterThan(0)
    await expectNoAxeViolations()
  })

  test('the card menu has no axe violations', async () => {
    showBoard(makeTicket({ title: 'Alpha' }))
    renderWithMantine(<Board />)
    await userEvent.click(screen.getByRole('button', { name: /Alpha/ }), { pointerEventsCheck: 0 })
    screen.getByRole('button', { name: /Alpha/ }).focus()
    await userEvent.keyboard('{Shift>}{F10}{/Shift}')
    await screen.findByRole('menuitem', { name: 'Move to Ready' })
    await expectNoAxeViolations()
  })
})

describe('Merge… in the card menu', () => {
  test('a Review card with a branch offers Merge…, which opens the dialog', async () => {
    const ticket = makeTicket({ title: 'Merge me', branch: 'mainbus/4-merge-me' }, { column: 'review', phase: 'ready_for_review' })
    showBoard(ticket)
    mockInvoke.mockImplementation(async (command: string) =>
      command === 'ticket.mergePreview'
        ? { ok: false, reason: 'Your checkout (/repo) has uncommitted changes: a.txt', suggest: 'commit_or_stash' }
        : { tickets: [ticket] }
    )
    renderWithMantine(<Board />)
    screen.getByRole('button', { name: /Merge me/ }).focus()
    await userEvent.keyboard('{Shift>}{F10}{/Shift}')
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Merge…' }))
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ticket.mergePreview', ticket.id))
    expect(await screen.findByText(/has uncommitted changes: a\.txt/)).toBeInTheDocument()
  })

  test('only a Review card with a branch has it', async () => {
    const backlog = makeTicket({ title: 'Not yet', branch: 'mainbus/5-not-yet' }, { column: 'backlog' })
    showBoard(backlog)
    mockInvoke.mockResolvedValue({ tickets: [backlog] })
    renderWithMantine(<Board />)
    screen.getByRole('button', { name: /Not yet/ }).focus()
    await userEvent.keyboard('{Shift>}{F10}{/Shift}')
    await screen.findByRole('menuitem', { name: 'Move to Ready' })
    expect(screen.queryByRole('menuitem', { name: 'Merge…' })).not.toBeInTheDocument()
  })
})

test("the header warns when the base branch isn't on origin", async () => {
  mockInvoke.mockImplementation(async (command: string) =>
    command === 'workspace.branches'
      ? { baseBranch: 'fm/x', branches: [], defaultBranch: 'main', hasRemote: true, baseOnRemote: false }
      : { tickets: [] }
  )
  showBoard(makeTicket({}, { column: 'backlog' }))
  renderWithMantine(<Board />)
  expect(await screen.findByText("Pull requests will fail: fm/x isn't on origin")).toBeInTheDocument()
})

test('the header has no warning when the base is on origin', async () => {
  mockInvoke.mockImplementation(async (command: string) =>
    command === 'workspace.branches'
      ? { baseBranch: 'main', branches: [], defaultBranch: 'main', hasRemote: true, baseOnRemote: true }
      : { tickets: [] }
  )
  showBoard(makeTicket({}, { column: 'backlog' }))
  renderWithMantine(<Board />)
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('workspace.branches', workspace.id))
  expect(screen.queryByText(/Pull requests will fail/)).not.toBeInTheDocument()
})
