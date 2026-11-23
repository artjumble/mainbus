import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke, onEngineEvent } from '../api'
import { useMainbus } from '../store'
import type { TicketState } from '../../../shared/domain'
import { makeTicket, renderWithMantine, workspace } from '../test-utils'
import { TicketView } from './TicketView'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), isSetupRequired: () => false }))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

function show(state: Partial<TicketState>): ReturnType<typeof makeTicket> {
  const ticket = makeTicket({ title: 'Add dark mode', number: 131 }, state)
  useMainbus.setState({ workspace, tickets: [ticket], currentTicketId: ticket.id })
  return ticket
}

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'thread.get') return { events: [], decisions: [], runs: [] }
    if (command === 'board.get') return { tickets: useMainbus.getState().tickets }
    if (command === 'ticket.move') return 'moved'
    return undefined
  })
  vi.mocked(onEngineEvent).mockImplementation(() => () => {})
})

async function chooseReady(): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: 'Move to…' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Ready' }))
}

const moves = (): unknown[][] => mockInvoke.mock.calls.filter(([c]) => c === 'ticket.move')

describe('the ticket view move', () => {
  test('a running ticket asks first, naming the consequence, with Cancel focused', async () => {
    show({ phase: 'implementing', agentStatus: 'working', column: 'in_progress' })
    renderWithMantine(<TicketView />)
    await chooseReady()
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/#131 is running \(.+\)\. Moving it to Ready stops its agent; the work so far stays on its branch, but the run must start again\. Move it\?/)
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus())
    expect(moves()).toEqual([])
  })

  test('Cancel leaves the ticket untouched and focus returns to the move control', async () => {
    show({ phase: 'implementing', agentStatus: 'working', column: 'in_progress' })
    renderWithMantine(<TicketView />)
    await chooseReady()
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(moves()).toEqual([])
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move to…' })).toHaveFocus())
  })

  test('Move and stop moves it', async () => {
    const ticket = show({ phase: 'implementing', agentStatus: 'working', column: 'in_progress' })
    renderWithMantine(<TicketView />)
    await chooseReady()
    await userEvent.click(await screen.findByRole('button', { name: 'Move and stop' }))
    await waitFor(() => expect(moves()).toEqual([['ticket.move', ticket.id, 'ready']]))
  })

  test('a ticket waiting on you asks too', async () => {
    show({ phase: 'implementing', agentStatus: 'waiting_on_you', column: 'needs_you' })
    renderWithMantine(<TicketView />)
    await chooseReady()
    expect(await screen.findByRole('dialog')).toHaveTextContent(/is waiting for you/)
  })

  test('a ticket with no agent open moves without asking', async () => {
    const ticket = show({ column: 'backlog', phase: 'not_started', agentStatus: null })
    renderWithMantine(<TicketView />)
    await chooseReady()
    await waitFor(() => expect(moves()).toEqual([['ticket.move', ticket.id, 'ready']]))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('the Owner items of the move menu', () => {
  const setOwners = (): unknown[][] => mockInvoke.mock.calls.filter(([c]) => c === 'ticket.setOwner')

  test('Mine marks an agents ticket as yours; Hand to agents is not offered', async () => {
    const ticket = show({ column: 'backlog', phase: 'not_started', agentStatus: null })
    renderWithMantine(<TicketView />)
    await userEvent.click(await screen.findByRole('button', { name: 'Move to…' }))
    expect(screen.queryByRole('menuitem', { name: 'Hand to agents' })).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Mine' }))
    await waitFor(() => expect(setOwners()).toEqual([['ticket.setOwner', ticket.id, 'human']]))
  })

  test('Hand to agents asks first, then hands the ticket over', async () => {
    const ticket = makeTicket({ title: 'Check on a Mac', number: 7, owner: 'human' }, { column: 'backlog', phase: 'not_started', agentStatus: null })
    useMainbus.setState({ workspace, tickets: [ticket], currentTicketId: ticket.id })
    renderWithMantine(<TicketView />)
    await userEvent.click(await screen.findByRole('button', { name: 'Move to…' }))
    expect(screen.queryByRole('menuitem', { name: 'Mine' })).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Hand to agents' }))
    const dialog = await screen.findByRole('dialog', { name: 'Hand #7 to agents?' })
    expect(setOwners()).toEqual([])
    await userEvent.click(within(dialog).getByRole('button', { name: 'Hand to agents' }))
    await waitFor(() => expect(setOwners()).toEqual([['ticket.setOwner', ticket.id, 'agent']]))
  })

  test("a refusal shows the engine's message", async () => {
    show({ column: 'backlog', phase: 'not_started', agentStatus: null })
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'ticket.setOwner') throw new Error('#1 has a run open; stop it before changing who owns it')
      if (command === 'thread.get') return { events: [], decisions: [], runs: [] }
      if (command === 'board.get') return { tickets: useMainbus.getState().tickets }
      return undefined
    })
    renderWithMantine(<TicketView />)
    await userEvent.click(await screen.findByRole('button', { name: 'Move to…' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Mine' }))
    expect(await screen.findByText(/has a run open; stop it before changing who owns it/)).toBeInTheDocument()
  })
})
