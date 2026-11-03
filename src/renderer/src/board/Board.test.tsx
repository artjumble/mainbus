import type { DragEndEvent } from '@dnd-kit/core'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, makeLineup, makeTicket, renderWithMantine, workspace } from '../test-utils'
import { Board } from './Board'

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

  const counts = ['Backlog', 'Ready', 'In progress', 'Needs you', 'Review', 'Done'].map((name) =>
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
  expect(mockInvoke).not.toHaveBeenCalled()
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
  expect(mockInvoke).not.toHaveBeenCalled()
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
    expect(mockInvoke).toHaveBeenCalledTimes(1)

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
    expect(screen.getAllByText('No matches')).toHaveLength(5)
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
