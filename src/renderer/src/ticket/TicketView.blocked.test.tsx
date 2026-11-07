import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke, onEngineEvent } from '../api'
import { useMainbus } from '../store'
import { makeTicket, renderWithMantine, workspace } from '../test-utils'
import { TicketView } from './TicketView'

vi.mock('../api', () => ({
  invoke: vi.fn(),
  onEngineEvent: vi.fn(),
  isSetupRequired: () => false
}))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

function show(blockers: { number: number; done: boolean }[]) {
  const ticket = makeTicket(
    { title: 'Add dark mode', number: 12, blockedBy: blockers.map((b) => ({ id: `b${b.number}`, number: b.number, title: `B${b.number}`, done: b.done })) },
    { column: 'ready' }
  )
  useMainbus.setState({ workspace, tickets: [ticket], currentTicketId: ticket.id })
  return ticket
}
const startCalls = () => mockInvoke.mock.calls.filter(([cmd]) => cmd === 'agent.start')
const sendCalls = () => mockInvoke.mock.calls.filter(([cmd]) => cmd === 'agent.send')

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'thread.get') return { events: [], decisions: [], runs: [] }
    if (command === 'board.get') return { tickets: useMainbus.getState().tickets }
    return undefined
  })
  vi.mocked(onEngineEvent).mockImplementation(() => () => {})
})

test('Start on a blocked ticket asks first; Cancel starts nothing', async () => {
  show([{ number: 39, done: false }])
  renderWithMantine(<TicketView />)
  await userEvent.click(await screen.findByRole('button', { name: 'Start' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText("#39 isn't Done yet. Start anyway?")).toBeInTheDocument()
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(startCalls()).toEqual([])
})

test('Start anyway sends startAnyway', async () => {
  const ticket = show([{ number: 39, done: false }, { number: 40, done: false }])
  renderWithMantine(<TicketView />)
  await userEvent.click(await screen.findByRole('button', { name: 'Start' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText("#39 and #40 aren't Done yet. Start anyway?")).toBeInTheDocument()
  await userEvent.click(within(dialog).getByRole('button', { name: 'Start anyway' }))
  await vi.waitFor(() => expect(startCalls()).toEqual([['agent.start', ticket.id, { startAnyway: true }]]))
})

test('the first-message send asks too, and keeps the text when cancelled', async () => {
  show([{ number: 39, done: false }])
  renderWithMantine(<TicketView />)
  const box = await screen.findByLabelText('First message (starts the lineup)')
  await userEvent.type(box, 'Begin')
  await userEvent.click(screen.getByRole('button', { name: /^Send/ }))
  const dialog = await screen.findByRole('dialog')
  expect(startCalls()).toEqual([])
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(box).toHaveValue('Begin')
  expect(sendCalls()).toEqual([])
})

test('a ticket whose blockers are all Done starts with no question', async () => {
  const ticket = show([{ number: 39, done: true }])
  renderWithMantine(<TicketView />)
  await userEvent.click(await screen.findByRole('button', { name: 'Start' }))
  expect(mockInvoke).toHaveBeenCalledWith('agent.start', ticket.id)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
