import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke, onEngineEvent } from '../api'
import { useMainbus } from '../store'
import { makeTicket, renderWithMantine, workspace } from '../test-utils'
import { ContextPane } from './ContextPane'
import { TicketView } from './TicketView'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), isSetupRequired: () => false }))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

const doneState = { column: 'done', phase: 'done' } as const
const archivedTicket = () =>
  makeTicket({ id: 'a1', number: 7, title: 'Old login', manualColumn: 'done', doneAt: '2026-11-01T00:00:00.000Z', archivedAt: '2026-11-10T00:00:00.000Z' }, doneState)

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'thread.get') return { events: [], decisions: [], runs: [] }
    if (command === 'board.get') return { tickets: useMainbus.getState().tickets, archived: 0 }
    return undefined
  })
  vi.mocked(onEngineEvent).mockImplementation(() => () => {})
})

test('an archived ticket that is not on the board shows from the store: badge, note, Restore, no editing', async () => {
  const t = archivedTicket()
  useMainbus.setState({ workspace, tickets: [], offBoardTicket: t, currentTicketId: t.id })
  renderWithMantine(<TicketView />)
  expect(await screen.findByRole('heading', { name: 'Old login' })).toBeInTheDocument()
  expect(screen.getByText('Archived')).toBeInTheDocument()
  expect(screen.getByText('This ticket is archived. Restore puts it back in Done.')).toBeInTheDocument()
  expect(screen.getByText('This ticket is done.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
})

test('while the archived ticket is read, a spinner shows; if it cannot be read, the old message does', () => {
  useMainbus.setState({ workspace, tickets: [], currentTicketId: 'a1', offBoardLoading: true })
  const view = renderWithMantine(<TicketView />)
  expect(screen.getByLabelText('Loading the ticket')).toBeInTheDocument()
  expect(screen.queryByText('This ticket is no longer on the board.')).not.toBeInTheDocument()
  view.unmount()
  useMainbus.setState({ offBoardLoading: false })
  renderWithMantine(<TicketView />)
  expect(screen.getByText('This ticket is no longer on the board.')).toBeInTheDocument()
})

test('opened from the Archive, the back link says Archive and returns to it', async () => {
  const t = archivedTicket()
  useMainbus.setState({ workspace, tickets: [], offBoardTicket: t, currentTicketId: t.id, archiveOpen: true })
  renderWithMantine(<TicketView />)
  await userEvent.click(await screen.findByRole('button', { name: '← Archive' }))
  expect(useMainbus.getState().currentTicketId).toBeNull()
  expect(useMainbus.getState().archiveOpen).toBe(true)
})

test('Restore puts it back in Done, announces it, and refreshes the board', async () => {
  const t = archivedTicket()
  useMainbus.setState({ workspace, tickets: [], offBoardTicket: t, currentTicketId: t.id })
  renderWithMantine(<TicketView />)
  await userEvent.click(await screen.findByRole('button', { name: 'Restore' }))
  expect(mockInvoke).toHaveBeenCalledWith('ticket.unarchive', ['a1'])
  await vi.waitFor(() => expect(useMainbus.getState().announcement?.text).toBe('Restored #7 Old login to Done'))
  expect(mockInvoke).toHaveBeenCalledWith('board.get')
})

test('a Done ticket on the board has Archive, which archives it and announces it', async () => {
  const t = { ...archivedTicket(), archivedAt: null }
  useMainbus.setState({ workspace, tickets: [t], currentTicketId: t.id })
  renderWithMantine(<TicketView />)
  expect(screen.queryByText('Archived')).not.toBeInTheDocument()
  await userEvent.click(await screen.findByRole('button', { name: 'Archive' }))
  expect(mockInvoke).toHaveBeenCalledWith('ticket.archive', ['a1'])
  await vi.waitFor(() => expect(useMainbus.getState().announcement?.text).toBe('Archived #7 Old login'))
})

test('a ticket that is not Done has no Archive button', async () => {
  const t = makeTicket({ id: 'r1', number: 3 }, { column: 'ready' })
  useMainbus.setState({ workspace, tickets: [t], currentTicketId: t.id })
  renderWithMantine(<TicketView />)
  await screen.findByRole('heading', { name: t.title })
  expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument()
})

describe('links to archived tickets', () => {
  test('blockers are links that open the ticket, archived or not, and say which', async () => {
    const t = makeTicket({
      id: 'b1',
      number: 9,
      blockedBy: [
        { id: 'a1', number: 7, title: 'Old login', done: true, archived: true },
        { id: 'c1', number: 8, title: 'Schema', done: false, archived: false }
      ]
    })
    useMainbus.setState({ workspace, tickets: [t] })
    renderWithMantine(<ContextPane ticket={t} events={[]} decisions={[]} />)
    const list = screen.getByRole('list', { name: 'Blockers' })
    expect(within(list).getByText('(Archived)')).toBeInTheDocument()
    await userEvent.click(within(list).getByRole('button', { name: '#7 Old login' }))
    expect(useMainbus.getState().currentTicketId).toBe('a1')
    // The ticket isn't on the board: the store reads it.
    expect(mockInvoke).toHaveBeenCalledWith('ticket.view', 'a1')
  })

  test('an archived blocker keeps its name in the picker', () => {
    const t = makeTicket({ id: 'b1', number: 9, blockedBy: [{ id: 'a1', number: 7, title: 'Old login', done: true, archived: true }] })
    useMainbus.setState({ workspace, tickets: [t] })
    renderWithMantine(<ContextPane ticket={t} events={[]} decisions={[]} />)
    expect(within(screen.getByRole('region', { name: 'Blocked by' })).getAllByText(/#7 Old login/).length).toBeGreaterThan(0)
  })

  test('the promotion link to an archived ticket opens it, marked archived', async () => {
    const t = makeTicket({ id: 'b1', number: 9, promotedFrom: 'a1', promotion: { from: { id: 'a1', number: 7, title: 'Why slow', archived: true }, to: null } })
    useMainbus.setState({ workspace, tickets: [t] })
    renderWithMantine(<ContextPane ticket={t} events={[]} decisions={[]} />)
    expect(screen.getByText(/Promoted from/)).toHaveTextContent('Promoted from #7 Why slow (archived)')
    await userEvent.click(screen.getByRole('button', { name: '#7 Why slow' }))
    expect(useMainbus.getState().currentTicketId).toBe('a1')
  })
})
