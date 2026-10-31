import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { EngineEvent } from '../../../shared/api'
import type { Decision, TicketState } from '../../../shared/domain'
import type { StoredEvent } from '../../../shared/events'
import { invoke, onEngineEvent } from '../api'
import { useMainbus } from '../store'
import { makeDecision, makeEvent, makeTicket, renderWithMantine, workspace } from '../test-utils'
import { TicketView } from './TicketView'

vi.mock('../api', () => ({
  invoke: vi.fn(),
  onEngineEvent: vi.fn(),
  isSetupRequired: () => false
}))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

let emit: (e: EngineEvent) => void = () => {}
let thread: { events: StoredEvent[]; decisions: Decision[] } = { events: [], decisions: [] }

function show(state: Partial<TicketState>): ReturnType<typeof makeTicket> {
  const ticket = makeTicket({ title: 'Add dark mode', number: 12 }, state)
  useMainbus.setState({ workspace, tickets: [ticket], currentTicketId: ticket.id })
  return ticket
}

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  thread = { events: [], decisions: [] }
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'thread.get') return thread
    if (command === 'board.get') return { tickets: useMainbus.getState().tickets }
    return undefined
  })
  vi.mocked(onEngineEvent).mockImplementation((listener) => {
    emit = listener
    return () => {}
  })
})

test('the header shows number, title, phase and source, and links back to the board', async () => {
  show({ phase: 'implementing', agentStatus: 'working', column: 'in_progress' })
  renderWithMantine(<TicketView />)
  expect(screen.getByText('#12')).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Add dark mode' })).toBeInTheDocument()
  expect(screen.getByText('is')).toBeInTheDocument()
  expect(screen.getByText('Implementing')).toBeInTheDocument()
  expect(screen.getByText('Source: Local')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '← mainbus board' }))
  expect(useMainbus.getState().currentTicketId).toBeNull()
})

test('TicketView controls follow state: working shows Stop', async () => {
  const ticket = show({ phase: 'implementing', agentStatus: 'working', column: 'in_progress' })
  renderWithMantine(<TicketView />)
  await userEvent.click(await screen.findByRole('button', { name: 'Stop' }))
  expect(mockInvoke).toHaveBeenCalledWith('agent.stop', ticket.id)
  expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument()
})

test('TicketView controls follow state: canContinue shows Continue, and Stop so a paused run can be abandoned', async () => {
  const ticket = show({ phase: 'implementing', agentStatus: 'paused', column: 'in_progress', canContinue: true })
  renderWithMantine(<TicketView />)
  await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  expect(mockInvoke).toHaveBeenCalledWith('agent.continue', ticket.id)
  await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
  expect(mockInvoke).toHaveBeenCalledWith('agent.stop', ticket.id)
  expect(screen.queryByRole('button', { name: /^Start/ })).not.toBeInTheDocument()
})

test('with no run, Start and a first-message composer show; the first send starts then sends', async () => {
  const ticket = show({ column: 'ready' })
  renderWithMantine(<TicketView />)
  expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument()
  await userEvent.type(screen.getByPlaceholderText('First message (starts the lineup)'), 'Begin with the header')
  await userEvent.click(screen.getByRole('button', { name: 'Send' }))
  const calls = mockInvoke.mock.calls.map((c) => c.slice(0, 3)).filter(([cmd]) => String(cmd).startsWith('agent.'))
  expect(calls).toEqual([
    ['agent.start', ticket.id],
    ['agent.send', ticket.id, 'Begin with the header']
  ])
})

test('Start alone starts the agent', async () => {
  const ticket = show({ column: 'ready' })
  renderWithMantine(<TicketView />)
  await userEvent.click(await screen.findByRole('button', { name: 'Start' }))
  expect(mockInvoke).toHaveBeenCalledWith('agent.start', ticket.id)
})

test('while an agent exists the composer sends a message to it', async () => {
  const ticket = show({ phase: 'implementing', agentStatus: 'working', column: 'in_progress' })
  renderWithMantine(<TicketView />)
  await userEvent.type(await screen.findByPlaceholderText('Message the Implementer'), 'Use tabs')
  await userEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(mockInvoke).toHaveBeenCalledWith('agent.send', ticket.id, 'Use tabs')
  expect(mockInvoke).not.toHaveBeenCalledWith('agent.start', ticket.id)
})

test('a failed command is reported', async () => {
  show({ phase: 'implementing', agentStatus: 'working', column: 'in_progress' })
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'thread.get') return thread
    throw new Error('The engine said no')
  })
  renderWithMantine(<TicketView />)
  await userEvent.click(await screen.findByRole('button', { name: 'Stop' }))
  expect(await screen.findByText('The engine said no')).toBeInTheDocument()
})

test('the thread loads, then follows live events: partials are replaced by the final message', async () => {
  const ticket = show({ phase: 'implementing', agentStatus: 'working', column: 'in_progress' })
  thread = { events: [makeEvent({ kind: 'user_message', text: 'Earlier words' })], decisions: [] }
  renderWithMantine(<TicketView />)
  expect(await screen.findByText('Earlier words')).toBeInTheDocument()

  const partial = (text: string): StoredEvent => makeEvent({ kind: 'message', text, partial: true }, { seq: 0 })
  act(() => emit({ type: 'thread.appended', ticketId: ticket.id, event: partial('Working on') }))
  expect(screen.getByText('Working on')).toBeInTheDocument()
  act(() => emit({ type: 'thread.appended', ticketId: ticket.id, event: partial('Working on it') }))
  act(() => emit({ type: 'thread.appended', ticketId: ticket.id, event: makeEvent({ kind: 'message', text: 'Working on it now.' }) }))
  expect(screen.getByText('Working on it now.')).toBeInTheDocument()
  expect(screen.queryByText('Working on it')).not.toBeInTheDocument()

  // Another ticket's events are ignored.
  act(() => emit({ type: 'thread.appended', ticketId: 'other', event: makeEvent({ kind: 'message', text: 'Not mine' }) }))
  expect(screen.queryByText('Not mine')).not.toBeInTheDocument()
})

test('a decision card appears from the thread and updates when decision.changed arrives', async () => {
  const ticket = show({ phase: 'waiting_on_you', agentStatus: 'waiting_on_you', column: 'needs_you' })
  const decision = makeDecision({ ticketId: ticket.id })
  thread = { events: [makeEvent({ kind: 'decision', decisionId: decision.id })], decisions: [decision] }
  renderWithMantine(<TicketView />)
  expect(await screen.findByText('Which database?')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Answer' })).toBeInTheDocument()

  act(() =>
    emit({
      type: 'decision.changed',
      decision: { ...decision, status: 'answered', answer: { kind: 'option', index: 0 }, answeredAt: '2026-10-30T10:05:00.000Z' }
    })
  )
  expect(screen.getByText('✓ Answered: SQLite')).toBeInTheDocument()
})

test('a decision announced live shows its card', async () => {
  const ticket = show({ phase: 'waiting_on_you', agentStatus: 'waiting_on_you', column: 'needs_you' })
  renderWithMantine(<TicketView />)
  await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('thread.get', ticket.id))
  const decision = makeDecision({ ticketId: ticket.id, id: 'live', question: 'Live question?' })
  act(() => emit({ type: 'thread.appended', ticketId: ticket.id, event: makeEvent({ kind: 'decision', decisionId: 'live' }) }))
  act(() => emit({ type: 'decision.changed', decision }))
  expect(await screen.findByText('Live question?')).toBeInTheDocument()
})

test('events that arrive while the thread loads are not lost', async () => {
  const ticket = show({ phase: 'implementing', agentStatus: 'working', column: 'in_progress' })
  let release: (t: typeof thread) => void = () => {}
  mockInvoke.mockImplementation(
    (command: string) => (command === 'thread.get' ? new Promise((r) => (release = r)) : Promise.resolve(undefined))
  )
  renderWithMantine(<TicketView />)
  const early = makeEvent({ kind: 'message', text: 'Arrived early' })
  act(() => emit({ type: 'thread.appended', ticketId: ticket.id, event: early }))
  await act(async () => release({ events: [early, makeEvent({ kind: 'message', text: 'From storage' })], decisions: [] }))
  expect(screen.getAllByText('Arrived early')).toHaveLength(1)
  expect(screen.getByText('From storage')).toBeInTheDocument()
})

test('a missing ticket offers the way back', async () => {
  useMainbus.setState({ workspace, tickets: [], currentTicketId: 'gone' })
  renderWithMantine(<TicketView />)
  expect(screen.getByText('This ticket is no longer on the board.')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '← mainbus board' }))
  expect(useMainbus.getState().currentTicketId).toBeNull()
})

const agentCalls = (): unknown[][] =>
  mockInvoke.mock.calls.map((c) => c.slice(0, 3)).filter(([cmd]) => String(cmd).startsWith('agent.'))

test.each(['failed', 'handed_off'] as const)('after a %s run, Start again and a new-run composer show', async (agentStatus) => {
  const ticket = show({ column: agentStatus === 'failed' ? 'needs_you' : 'review', phase: 'implementing', agentStatus })
  renderWithMantine(<TicketView />)
  expect(await screen.findByRole('button', { name: 'Start again' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  await userEvent.type(screen.getByPlaceholderText('Message to start a new run'), 'Try again')
  await userEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(agentCalls()).toEqual([
    ['agent.start', ticket.id],
    ['agent.send', ticket.id, 'Try again']
  ])
})

test('Start again starts a new run', async () => {
  const ticket = show({ column: 'review', phase: 'ready_for_review', agentStatus: 'handed_off' })
  renderWithMantine(<TicketView />)
  await userEvent.click(await screen.findByRole('button', { name: 'Start again' }))
  expect(mockInvoke).toHaveBeenCalledWith('agent.start', ticket.id)
})

test('a done ticket shows neither Start nor a composer', async () => {
  show({ column: 'done', phase: 'done' })
  renderWithMantine(<TicketView />)
  expect(await screen.findByText('This ticket is done.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /^Start/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: /message/i })).not.toBeInTheDocument()
})

test('a retry after a failed send does not start the agent twice', async () => {
  const ticket = show({ column: 'ready' })
  let sends = 0
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'thread.get') return thread
    if (command === 'agent.send' && ++sends === 1) throw new Error('not delivered')
    return undefined
  })
  renderWithMantine(<TicketView />)
  await userEvent.type(await screen.findByPlaceholderText('First message (starts the lineup)'), 'Go')
  await userEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(await screen.findByText('not delivered')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(sends).toBe(2))
  expect(agentCalls().filter(([cmd]) => cmd === 'agent.start')).toEqual([['agent.start', ticket.id]])
})

test('Start and the first-message send share one busy flag, so the agent starts once', async () => {
  const ticket = show({ column: 'ready' })
  let finishStart: () => void = () => {}
  mockInvoke.mockImplementation((command: string) => {
    if (command === 'thread.get') return Promise.resolve(thread)
    if (command === 'agent.start') return new Promise<void>((r) => (finishStart = r))
    return Promise.resolve(undefined)
  })
  renderWithMantine(<TicketView />)
  const box = await screen.findByPlaceholderText('First message (starts the lineup)')
  await userEvent.click(screen.getByRole('button', { name: 'Start' }))
  expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled()
  await userEvent.type(box, 'Hello')
  await userEvent.click(screen.getByRole('button', { name: 'Send' }))
  finishStart()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled())
  expect(agentCalls().filter(([cmd]) => cmd === 'agent.start')).toEqual([['agent.start', ticket.id]])
  expect(agentCalls().filter(([cmd]) => cmd === 'agent.send')).toEqual([])
})
