import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { ContextPane } from '../ticket/ContextPane'
import { useMainbus } from '../store'
import { makeTicket, renderWithMantine } from '../test-utils'
import { NewTicketModal } from './NewTicketModal'
import { TicketCard } from './TicketCard'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn(), isSetupRequired: () => false }))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

const blocker = (number: number, done: boolean) => ({ id: `b${number}`, number, title: `B${number}`, done })
const others = [
  makeTicket({ id: 'a', number: 1, title: 'Schema' }),
  makeTicket({ id: 'b', number: 2, title: 'Api', manualColumn: 'done' }),
  makeTicket({ id: 'c', number: 3, title: 'Screen' })
]

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command: string) => (command === 'board.get' ? { tickets: [] } : {}))
})

describe('the Blocked by chip', () => {
  test('names the blockers that are not Done, and goes when they all are', () => {
    const first = renderWithMantine(<TicketCard ticket={makeTicket({ blockedBy: [blocker(39, false), blocker(40, false)] })} onOpen={() => {}} />)
    expect(screen.getByText('Blocked by #39 and #40').closest('[data-blocked-chip]')).not.toBeNull()
    first.unmount()
    const half = renderWithMantine(<TicketCard ticket={makeTicket({ blockedBy: [blocker(39, true), blocker(40, false)] })} onOpen={() => {}} />)
    expect(screen.getByText('Blocked by #40')).toBeInTheDocument()
    half.unmount()
    renderWithMantine(<TicketCard ticket={makeTicket({ blockedBy: [blocker(39, true)] })} onOpen={() => {}} />)
    expect(screen.queryByText(/Blocked by/)).not.toBeInTheDocument()
  })

  test('a Done ticket shows none', () => {
    renderWithMantine(<TicketCard ticket={makeTicket({ manualColumn: 'done', blockedBy: [blocker(3, false)] })} onOpen={() => {}} />)
    expect(screen.queryByText(/Blocked by/)).not.toBeInTheDocument()
  })
})

describe('the ticket view picker', () => {
  test('lists the other tickets by number and title, Done ones marked, and saves the choice at once', async () => {
    useMainbus.setState({ tickets: others })
    renderWithMantine(<ContextPane ticket={makeTicket({ id: 'c', number: 3, title: 'Screen' })} events={[]} decisions={[]} />)
    const section = screen.getByRole('region', { name: 'Blocked by' })
    await userEvent.click(within(section).getByRole('combobox', { name: /Blocked by/ }))
    expect(await screen.findByRole('option', { name: '#1 Schema' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '#2 Api (Done)' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /#3 Screen/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('option', { name: '#1 Schema' }))
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ticket.setBlockedBy', 'c', ['a']))
  })

  test('shows the saved blockers', () => {
    useMainbus.setState({ tickets: others })
    const t = makeTicket({ id: 'c', number: 3, blockedBy: [{ id: 'a', number: 1, title: 'Schema', done: false }] })
    renderWithMantine(<ContextPane ticket={t} events={[]} decisions={[]} />)
    expect(within(screen.getByRole('region', { name: 'Blocked by' })).getAllByText('#1 Schema').length).toBeGreaterThan(0)
  })

  test('a refused change is reported', async () => {
    useMainbus.setState({ tickets: others })
    mockInvoke.mockRejectedValue(new Error("#2 is already blocked by #3, so #3 can't be blocked by #2"))
    renderWithMantine(<ContextPane ticket={makeTicket({ id: 'c', number: 3 })} events={[]} decisions={[]} />)
    await userEvent.click(within(screen.getByRole('region', { name: 'Blocked by' })).getByRole('combobox', { name: /Blocked by/ }))
    await userEvent.click(await screen.findByRole('option', { name: '#2 Api (Done)' }))
    expect(await screen.findByText(/can't be blocked by #2/)).toBeInTheDocument()
  })

  test('Activity says when it was started anyway and when it was unblocked', () => {
    const t = makeTicket({
      dependencyNotes: [
        { id: 'n1', at: '2026-10-31T10:00:00.000Z', kind: 'started_blocked', via: 'ticket', blockers: [{ number: 1, title: 'Schema' }] },
        { id: 'n2', at: '2026-10-31T11:00:00.000Z', kind: 'unblocked', via: null, blockers: [{ number: 1, title: 'Schema' }, { number: 2, title: 'Api' }] }
      ]
    })
    renderWithMantine(<ContextPane ticket={t} events={[]} decisions={[]} />)
    const activity = screen.getByRole('region', { name: 'Activity' })
    expect(within(activity).getByText('Started while blocked by #1 (you chose to start anyway)')).toBeInTheDocument()
    expect(within(activity).getByText('Unblocked: #1, #2 are Done')).toBeInTheDocument()
  })
})

describe('the New ticket dialog picker', () => {
  const fill = async (): Promise<void> => {
    await userEvent.type(screen.getByLabelText(/Title/), 'Screen')
    await userEvent.type(screen.getByLabelText(/In your words/), 'Build the screen')
  }

  test('lists the workspace tickets and sends the choice as ids', async () => {
    useMainbus.setState({ tickets: others })
    renderWithMantine(<NewTicketModal opened onClose={() => {}} />)
    await fill()
    await userEvent.click(screen.getByRole('combobox', { name: /Blocked by/ }))
    expect(await screen.findByRole('option', { name: '#2 Api (Done)' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('option', { name: '#1 Schema' }))
    await userEvent.click(screen.getByRole('button', { name: 'Create ticket' }))
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ticket.create', expect.objectContaining({ title: 'Screen', blockedBy: ['a'] })))
  })

  test('sends nothing for blockers when none were picked', async () => {
    renderWithMantine(<NewTicketModal opened onClose={() => {}} />)
    await fill()
    await userEvent.click(screen.getByRole('button', { name: 'Create ticket' }))
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ticket.create', expect.not.objectContaining({ blockedBy: expect.anything() })))
  })
})
