import type { DragEndEvent } from '@dnd-kit/core'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { makeTicket, renderWithMantine, workspace } from '../test-utils'
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
  drag(ticket.id, 'in_progress')
  drag(ticket.id, 'needs_you')
  drag(ticket.id, 'review')
  drag(ticket.id, null)
  drag(ticket.id, 'backlog') // already there
  expect(mockInvoke).not.toHaveBeenCalled()
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

describe('moving a card without dragging', () => {
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

test('the settings button in the header opens the workspace settings', async () => {
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'role.get') return { instructions: 'Be careful.', model: null, effort: null }
    if (command === 'allowRules.list') return []
    return { tickets: [] }
  })
  showBoard()
  renderWithMantine(<Board />)
  await userEvent.click(screen.getByRole('button', { name: 'Workspace settings' }))
  expect(await screen.findByLabelText('Instructions')).toBeInTheDocument()
})
