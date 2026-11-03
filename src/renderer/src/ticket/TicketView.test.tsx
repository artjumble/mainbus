import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { EngineEvent } from '../../../shared/api'
import type { Decision, RoleStatus, StripRole, TicketState } from '../../../shared/domain'
import type { StoredEvent, ThreadRun } from '../../../shared/events'
import { invoke, onEngineEvent } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, makeDecision, makeEvent, makeLineup, makeTicket, optionLabels, renderWithMantine, workspace } from '../test-utils'
import { TicketView } from './TicketView'

vi.mock('../api', () => ({
  invoke: vi.fn(),
  onEngineEvent: vi.fn(),
  isSetupRequired: () => false
}))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

let emit: (e: EngineEvent) => void = () => {}
let thread: { events: StoredEvent[]; decisions: Decision[]; runs: ThreadRun[] } = { events: [], decisions: [], runs: [] }
/** The run of the live events these tests emit. */
const run: ThreadRun = { id: 'r1', ticketRunId: 'tr1', role: 'Implementer' }

/** The default lineup's strip, with `active` (by id) open in `status` and the roles before it handed off. */
function strip(active: string | null, status: RoleStatus = 'working'): StripRole[] {
  const ids = makeLineup().map((r) => r.id)
  const at = active === null ? -1 : ids.indexOf(active)
  return makeLineup().map((r, i) => ({
    id: r.id,
    name: r.name,
    status: i === at ? status : i < at ? 'handed_off' : 'not_started',
    active: i === at,
    replacements: 0
  }))
}

function show(state: Partial<TicketState>, lineup?: StripRole[]): ReturnType<typeof makeTicket> {
  const ticket = makeTicket({ title: 'Add dark mode', number: 12, ...(lineup ? { lineup } : {}) }, state)
  useMainbus.setState({ workspace, tickets: [ticket], currentTicketId: ticket.id })
  return ticket
}

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  thread = { events: [], decisions: [], runs: [] }
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

describe('Pause, Resume and Skip to next role', () => {
  /** The Paused chip in the header, not the lineup strip's "Paused" for the role. */
  const CHIP = { selector: '.mantine-Badge-label' }

  test('a working role can be paused or skipped; a paused one resumed, skipped or stopped, and Continue is not offered', async () => {
    const working = show({ phase: 'implementing', agentStatus: 'working', column: 'in_progress' }, strip('i'))
    const { unmount } = renderWithMantine(<TicketView />)
    expect(screen.queryByText('Paused', CHIP)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skip to next role' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(mockInvoke).toHaveBeenCalledWith('agent.pause', working.id)
    unmount()

    const paused = show(
      { phase: 'implementing', agentStatus: 'paused', column: 'in_progress', pausedByUser: true },
      strip('i', 'paused')
    )
    renderWithMantine(<TicketView />)
    // The header carries the Paused chip beside the phase.
    expect(screen.getByText('Paused', CHIP)).toBeInTheDocument()
    expect(screen.getByText('Implementing')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skip to next role' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(mockInvoke).toHaveBeenCalledWith('agent.resume', paused.id)
  })

  test('a pause by the usage limit shows the reason and offers Resume, not Continue', async () => {
    const ticket = show(
      { phase: 'implementing', agentStatus: 'paused', column: 'in_progress', pausedByLimit: true, summary: 'Usage limit; resumes at 14:00' },
      strip('i', 'paused')
    )
    renderWithMantine(<TicketView />)
    expect(screen.getByText('Usage limit; resumes at 14:00')).toBeInTheDocument()
    expect(screen.getByText('Paused', CHIP)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(mockInvoke).toHaveBeenCalledWith('agent.resume', ticket.id)
  })

  test('a paused agent nobody paused on purpose offers Continue, not Resume', async () => {
    show({ phase: 'implementing', agentStatus: 'paused', column: 'in_progress', canContinue: true }, strip('i', 'paused'))
    renderWithMantine(<TicketView />)
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
    expect(screen.queryByText('Paused', CHIP)).not.toBeInTheDocument()
  })

  test('Skip asks first, naming the next role, and skips only once confirmed', async () => {
    const ticket = makeTicket(
      { title: 'Add dark mode', number: 12, lineup: strip('p'), skipTo: 'Implementer' },
      { phase: 'planning', agentStatus: 'working', column: 'in_progress' }
    )
    useMainbus.setState({ workspace, tickets: [ticket], currentTicketId: ticket.id })
    renderWithMantine(<TicketView />)

    await userEvent.click(screen.getByRole('button', { name: 'Skip to next role' }))
    const dialog = await screen.findByRole('dialog', { name: 'Skip to next role' })
    expect(within(dialog).getByText('Skip the Planner? Its work so far is summarised for the Implementer.')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(mockInvoke).not.toHaveBeenCalledWith('agent.skip', ticket.id)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'Skip to next role' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Skip' }))
    expect(mockInvoke).toHaveBeenCalledWith('agent.skip', ticket.id)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  test('on the last role, Skip says the ticket goes to Review', async () => {
    show({ phase: 'reviewing', agentStatus: 'working', column: 'in_progress' }, strip('r'))
    renderWithMantine(<TicketView />)
    await userEvent.click(screen.getByRole('button', { name: 'Skip to next role' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Skip the Reviewer? Its work so far is summarised and the ticket goes to Review.')).toBeInTheDocument()
  })

  test('a refused skip is reported and the dialog stays open', async () => {
    show({ phase: 'implementing', agentStatus: 'working', column: 'in_progress' }, strip('i'))
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'thread.get') return thread
      if (command === 'agent.skip') throw new Error('No agent is working on this ticket')
      return undefined
    })
    renderWithMantine(<TicketView />)
    await userEvent.click(screen.getByRole('button', { name: 'Skip to next role' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Skip' }))
    expect(await screen.findByText('No agent is working on this ticket')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  test('none of them show without an open run', () => {
    show({ column: 'ready' })
    renderWithMantine(<TicketView />)
    for (const name of ['Pause', 'Resume', 'Skip to next role']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
  })
})

test('with no run, Start and a first-message composer show; the first send starts then sends', async () => {
  const ticket = show({ column: 'ready' })
  renderWithMantine(<TicketView />)
  expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Adjust before starting' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'First message (starts the lineup)' })).toBeInTheDocument()
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
  const ticket = show({ phase: 'implementing', agentStatus: 'working', column: 'in_progress' }, strip('i'))
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
  thread = { events: [makeEvent({ kind: 'user_message', text: 'Earlier words' })], decisions: [], runs: [run] }
  renderWithMantine(<TicketView />)
  expect(await screen.findByText('Earlier words')).toBeInTheDocument()

  const partial = (text: string): StoredEvent => makeEvent({ kind: 'message', text, partial: true }, { seq: 0 })
  act(() => emit({ type: 'thread.appended', workspaceId: ticket.workspaceId, ticketId: ticket.id, event: partial('Working on'), run }))
  expect(screen.getByText('Working on')).toBeInTheDocument()
  act(() => emit({ type: 'thread.appended', workspaceId: ticket.workspaceId, ticketId: ticket.id, event: partial('Working on it'), run }))
  act(() => emit({ type: 'thread.appended', workspaceId: ticket.workspaceId, ticketId: ticket.id, event: makeEvent({ kind: 'message', text: 'Working on it now.' }), run }))
  expect(screen.getByText('Working on it now.')).toBeInTheDocument()
  expect(screen.queryByText('Working on it')).not.toBeInTheDocument()

  // Another ticket's events are ignored.
  act(() => emit({ type: 'thread.appended', workspaceId: ticket.workspaceId, ticketId: 'other', event: makeEvent({ kind: 'message', text: 'Not mine' }), run }))
  expect(screen.queryByText('Not mine')).not.toBeInTheDocument()
})

test('a decision card appears from the thread and updates when decision.changed arrives', async () => {
  const ticket = show({ phase: 'waiting_on_you', agentStatus: 'waiting_on_you', column: 'needs_you' })
  const decision = makeDecision({ ticketId: ticket.id })
  thread = { events: [makeEvent({ kind: 'decision', decisionId: decision.id })], decisions: [decision], runs: [run] }
  renderWithMantine(<TicketView />)
  expect(await screen.findByText('Which database?')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Answer' })).toBeInTheDocument()

  act(() =>
    emit({
      type: 'decision.changed',
      workspaceId: ticket.workspaceId,
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
  act(() => emit({ type: 'thread.appended', workspaceId: ticket.workspaceId, ticketId: ticket.id, event: makeEvent({ kind: 'decision', decisionId: 'live' }), run }))
  act(() => emit({ type: 'decision.changed', workspaceId: ticket.workspaceId, decision }))
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
  act(() => emit({ type: 'thread.appended', workspaceId: ticket.workspaceId, ticketId: ticket.id, event: early, run }))
  await act(async () => release({ events: [early, makeEvent({ kind: 'message', text: 'From storage' })], decisions: [], runs: [run] }))
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

test('while the board is moving the ticket, it stays as it was and cannot be started', async () => {
  const ticket = show({ column: 'review', phase: 'ready_for_review', agentStatus: 'handed_off' })
  useMainbus.setState({ pendingMoves: { [ticket.id]: 'done' } })
  renderWithMantine(<TicketView />)
  expect(await screen.findByRole('button', { name: 'Start again' })).toBeDisabled()
  expect(screen.getByText('Ready for review')).toBeInTheDocument()
  await userEvent.type(screen.getByPlaceholderText('Message to start a new run'), 'Try again')
  await userEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(agentCalls()).toEqual([])
  expect(screen.getByPlaceholderText('Message to start a new run')).toHaveValue('Try again')
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

test('the header links to the pull request once there is one', () => {
  const ticket = makeTicket({ title: 'Add dark mode', pr: { url: 'https://github.com/o/r/pull/3', number: 3 } }, { column: 'review' })
  useMainbus.setState({ workspace, tickets: [ticket], currentTicketId: ticket.id })
  renderWithMantine(<TicketView />)
  expect(screen.getByRole('link', { name: 'PR #3' })).toHaveAttribute('href', 'https://github.com/o/r/pull/3')
})

test("a PR failure shows the reason in Review, and Retry runs it again", async () => {
  const ticket = makeTicket({ prError: 'the repository has no origin remote' }, {
    column: 'review',
    phase: 'ready_for_review',
    agentStatus: 'handed_off'
  })
  useMainbus.setState({ workspace, tickets: [ticket], currentTicketId: ticket.id })
  renderWithMantine(<TicketView />)
  expect(screen.getByText("Couldn't open a PR: the repository has no origin remote")).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(mockInvoke).toHaveBeenCalledWith('ticket.openPr', ticket.id)
})

test('a refused Retry says why', async () => {
  const ticket = makeTicket({ prError: 'gh is not signed in' }, { column: 'review', agentStatus: 'handed_off' })
  useMainbus.setState({ workspace, tickets: [ticket], currentTicketId: ticket.id })
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'thread.get') return thread
    if (command === 'ticket.openPr') throw new Error('Only a ticket in Review can be pushed')
    return undefined
  })
  renderWithMantine(<TicketView />)
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('Only a ticket in Review can be pushed')).toBeInTheDocument()
})

test('the lineup strip shows the run’s roles in order with their status, the active one current', () => {
  show({ phase: 'implementing', agentStatus: 'working', column: 'in_progress' }, strip('i'))
  renderWithMantine(<TicketView />)
  const items = within(screen.getByRole('list', { name: 'Lineup' })).getAllByRole('listitem')
  expect(items.map((li) => li.textContent)).toEqual(['PlannerHanded off', 'ImplementerWorking', 'ReviewerNot started'])
  expect(items.map((li) => li.getAttribute('aria-current'))).toEqual([null, 'step', null])
})

test('the composer and the controls name the active role', async () => {
  show({ phase: 'reviewing', agentStatus: 'waiting_on_you', column: 'needs_you' }, strip('r', 'waiting_on_you'))
  renderWithMantine(<TicketView />)
  expect(await screen.findByPlaceholderText('Message the Reviewer')).toBeInTheDocument()
  const lineup = screen.getByRole('list', { name: 'Lineup' })
  expect(within(lineup).getByText('Waiting on you')).toBeInTheDocument()
})

test('with no active role the controls row names none', async () => {
  show({ column: 'ready' }, strip(null))
  renderWithMantine(<TicketView />)
  await screen.findByRole('button', { name: 'Start' })
  const lineup = screen.getByRole('list', { name: 'Lineup' })
  expect(within(lineup).getAllByText('Not started')).toHaveLength(3)
  expect(within(lineup).queryByRole('listitem', { current: 'step' })).not.toBeInTheDocument()
  // Only the strip names the roles.
  expect(screen.getAllByText('Implementer')).toHaveLength(1)
})

describe('Adjust before starting', () => {
  beforeEach(() => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'thread.get') return thread
      if (command === 'lineup.get') return makeLineup()
      return undefined
    })
  })

  test('lists the lineup roles all ticked, and starts only the ticked ones', async () => {
    const ticket = show({ column: 'ready' })
    renderWithMantine(<TicketView />)
    await userEvent.click(await screen.findByRole('button', { name: 'Adjust before starting' }))
    const dialog = await screen.findByRole('dialog', { name: 'Adjust before starting' })
    expect(await within(dialog).findAllByRole('checkbox')).toHaveLength(3)
    for (const name of ['1. Planner', '2. Implementer', '3. Reviewer']) expect(within(dialog).getByRole('checkbox', { name })).toBeChecked()

    await userEvent.click(within(dialog).getByRole('checkbox', { name: '1. Planner' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start' }))
    expect(agentCalls()).toEqual([
      [
        'agent.start',
        ticket.id,
        { roleIds: ['i', 'r'], roles: { i: { model: 'sonnet', effort: 'medium' }, r: { model: 'opus', effort: 'medium' } } }
      ]
    ])
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  test("prefills each role's model and effort from its own setting, else the defaults, and sends what the user chose", async () => {
    const [planner, implementer, reviewer] = makeLineup()
    const lineup = [planner!, { ...implementer!, model: 'claude-custom', effort: 'max' as const }, reviewer!]
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'thread.get') return thread
      if (command === 'lineup.get') return lineup
      return undefined
    })
    const ticket = show({ column: 'backlog' })
    renderWithMantine(<TicketView />)
    await userEvent.click(await screen.findByRole('button', { name: 'Adjust before starting' }))
    const dialog = await screen.findByRole('dialog', { name: 'Adjust before starting' })
    // The models and effort are in a section that starts collapsed.
    await userEvent.click(await within(dialog).findByRole('button', { name: /Models and effort per role/ }))
    const model = async (name: string) => within(dialog).findByRole('combobox', { name: `Model for ${name}` })
    const effort = (name: string) => within(dialog).getByRole('combobox', { name: `Effort for ${name}` })
    expect(await model('Planner')).toHaveValue('opus')
    expect(effort('Planner')).toHaveValue('high')
    // A role's own model shows even when it isn't one of the offered ones.
    expect(await model('Implementer')).toHaveValue('claude-custom')
    expect(effort('Implementer')).toHaveValue('max')
    expect(await model('Reviewer')).toHaveValue('opus')
    expect(effort('Reviewer')).toHaveValue('medium')
    expect(optionLabels(await model('Reviewer'))).toEqual(['Opus', 'Sonnet', 'Haiku'])
    expect(optionLabels(effort('Reviewer'))).toEqual(['Low', 'Medium', 'High'])

    await userEvent.selectOptions(await model('Planner'), 'Haiku')
    await userEvent.selectOptions(effort('Reviewer'), 'Low')
    await userEvent.click(within(dialog).getByRole('checkbox', { name: '2. Implementer' }))
    expect(await model('Implementer')).toBeDisabled()
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Extra instructions for this agent' }), 'Keep it small.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start' }))
    expect(agentCalls()).toEqual([
      [
        'agent.start',
        ticket.id,
        {
          roleIds: ['p', 'r'],
          roles: { p: { model: 'haiku', effort: 'high' }, r: { model: 'opus', effort: 'low' } },
          extraInstructions: 'Keep it small.'
        }
      ]
    ])
  })

  test('the last ticked role stays ticked, and Cancel starts nothing', async () => {
    show({ column: 'review', phase: 'ready_for_review', agentStatus: 'handed_off' })
    renderWithMantine(<TicketView />)
    // It sits next to Start again too.
    expect(await screen.findByRole('button', { name: 'Start again' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Adjust before starting' }))
    const dialog = await screen.findByRole('dialog', { name: 'Adjust before starting' })
    for (const name of ['1. Planner', '2. Implementer', '3. Reviewer']) {
      await userEvent.click(await within(dialog).findByRole('checkbox', { name }))
    }
    expect(within(dialog).getByRole('checkbox', { name: '3. Reviewer' })).toBeChecked()
    expect(within(dialog).getByRole('checkbox', { name: '3. Reviewer' })).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(agentCalls()).toEqual([])
  })

  test('a failed start is reported and keeps the dialog open', async () => {
    show({ column: 'ready' })
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'thread.get') return thread
      if (command === 'lineup.get') return makeLineup()
      if (command === 'agent.start') throw new Error('Tick at least one role to start')
      return undefined
    })
    renderWithMantine(<TicketView />)
    await userEvent.click(await screen.findByRole('button', { name: 'Adjust before starting' }))
    const dialog = await screen.findByRole('dialog', { name: 'Adjust before starting' })
    await within(dialog).findByRole('checkbox', { name: '1. Planner' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start' }))
    expect(await screen.findByText('Tick at least one role to start')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Adjust before starting' })).toBeInTheDocument()
  })

  test('is not offered while an agent works the ticket', async () => {
    show({ phase: 'implementing', agentStatus: 'working', column: 'in_progress' }, strip('i'))
    renderWithMantine(<TicketView />)
    await screen.findByRole('button', { name: 'Stop' })
    expect(screen.queryByRole('button', { name: 'Adjust before starting' })).not.toBeInTheDocument()
  })
})

test('a PR failure is not shown once the ticket has left Review', () => {
  const ticket = makeTicket({ prError: 'old failure' }, { column: 'in_progress', agentStatus: 'working' })
  useMainbus.setState({ workspace, tickets: [ticket], currentTicketId: ticket.id })
  renderWithMantine(<TicketView />)
  expect(screen.queryByText(/Couldn't open a PR/)).not.toBeInTheDocument()
})

describe('Replace…', () => {
  test('is offered for the active role at any time, and opens the replace card in the orchestrator panel', async () => {
    const ticket = show({ phase: 'implementing', agentStatus: 'working', column: 'in_progress' }, strip('i'))
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'thread.get') return thread
      if (command === 'ticket.proposeReplace') return { id: 'p9', kind: 'replace', status: 'pending' }
      return undefined
    })
    renderWithMantine(<TicketView />)
    // No stuck chip, no episode: the button is there anyway.
    expect(screen.queryByText(/stuck/i)).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: 'Replace…' }))
    expect(mockInvoke).toHaveBeenCalledWith('ticket.proposeReplace', ticket.id)
    await waitFor(() => expect(useMainbus.getState().revealedProposal).toMatchObject({ id: 'p9' }))
  })

  test('is offered to a paused role as well, and not without an open run', async () => {
    show({ phase: 'implementing', agentStatus: 'paused', column: 'in_progress', pausedByUser: true }, strip('i', 'paused'))
    const { unmount } = renderWithMantine(<TicketView />)
    expect(screen.getByRole('button', { name: 'Replace…' })).toBeInTheDocument()
    unmount()

    show({ phase: 'not_started', agentStatus: null, column: 'ready' })
    renderWithMantine(<TicketView />)
    expect(screen.queryByRole('button', { name: 'Replace…' })).not.toBeInTheDocument()
  })

  test('a refusal is shown and nothing is revealed', async () => {
    show({ phase: 'implementing', agentStatus: 'working', column: 'in_progress' }, strip('i'))
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'thread.get') return thread
      if (command === 'ticket.proposeReplace') throw new Error('#12 has no active role to replace')
      return undefined
    })
    renderWithMantine(<TicketView />)
    await userEvent.click(await screen.findByRole('button', { name: 'Replace…' }))
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ticket.proposeReplace', expect.any(String)))
    expect(useMainbus.getState().revealedProposal).toBeNull()
  })
})

describe('View previous run', () => {
  const OLD: ThreadRun = { id: 'old', ticketRunId: 'tr1', role: 'Implementer' }
  const NEW: ThreadRun = { id: 'new', ticketRunId: 'tr1', role: 'Implementer' }

  async function openReplaced(): Promise<void> {
    show({ phase: 'implementing', agentStatus: 'working', column: 'in_progress' })
    thread = {
      events: [
        makeEvent({ kind: 'message', text: 'The old agent looped.' }, { runId: 'old' }),
        makeEvent({ kind: 'replaced', role: 'Implementer', summary: 'It tried X.', source: 'summary' }, { runId: 'old' }),
        makeEvent({ kind: 'message', text: 'The new agent starts afresh.' }, { runId: 'new' })
      ],
      decisions: [],
      runs: [OLD, NEW]
    }
    renderWithMantine(<TicketView />)
    expect(await screen.findByText('The new agent starts afresh.')).toBeInTheDocument()
    // The thread's link comes after the Activity's in the page.
    await userEvent.click(screen.getAllByRole('button', { name: 'View previous run' }).at(-1)!)
  }

  test('opens the old run read-only: its events only, with no composer and no controls, and a way back', async () => {
    await openReplaced()
    const view = screen.getByRole('region', { name: 'Previous run of the Implementer' })
    expect(within(view).getByText('Previous run of the Implementer · read-only')).toBeInTheDocument()
    expect(within(view).getByText('The old agent looped.')).toBeInTheDocument()
    expect(screen.queryByText('The new agent starts afresh.')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /^Message/ })).not.toBeInTheDocument()
    for (const name of ['Stop', 'Pause', 'Replace…', 'Send']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
    expect(within(view).queryByRole('button', { name: 'View previous run' })).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Lineup' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '← Back to the live thread' }))
    expect(screen.getByText('The new agent starts afresh.')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Previous run of the Implementer' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /^Message/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
  })

  test('the Activity link to the previous run opens it too', async () => {
    await openReplaced()
    await userEvent.click(screen.getByRole('button', { name: '← Back to the live thread' }))
    const activity = screen.getByRole('region', { name: 'Activity' })
    await userEvent.click(within(activity).getByRole('button', { name: 'View previous run' }))
    expect(screen.getByRole('region', { name: 'Previous run of the Implementer' })).toBeInTheDocument()
  })
})

describe('accessibility', () => {
  test('a ticket with no run, with the Adjust modal open, has no axe violations', async () => {
    show({ column: 'ready' })
    mockInvoke.mockImplementation(async (command: string) => (command === 'lineup.get' ? makeLineup() : command === 'thread.get' ? thread : undefined))
    renderWithMantine(<TicketView />)
    await userEvent.click(await screen.findByRole('button', { name: 'Adjust before starting' }))
    await screen.findByRole('dialog', { name: 'Adjust before starting' })
    await expectNoAxeViolations()
  })

  test('a running ticket with a thread and the Skip modal open has no axe violations', async () => {
    const ticket = makeTicket(
      { title: 'Add dark mode', number: 12, lineup: strip('p'), skipTo: 'Implementer' },
      { phase: 'planning', agentStatus: 'working', column: 'in_progress' }
    )
    useMainbus.setState({ workspace, tickets: [ticket], currentTicketId: ticket.id })
    thread = {
      events: [makeEvent({ kind: 'user_message', text: 'Begin' }), makeEvent({ kind: 'message', text: 'On it.' })],
      decisions: [],
      runs: [run]
    }
    renderWithMantine(<TicketView />)
    await screen.findByText('On it.')
    await expectNoAxeViolations()
    await userEvent.click(screen.getByRole('button', { name: 'Skip to next role' }))
    await screen.findByRole('dialog', { name: 'Skip to next role' })
    await expectNoAxeViolations()
  })

  test('a waiting ticket with a pending question and a permission has no axe violations', async () => {
    const ticket = show({ column: 'needs_you', phase: 'waiting_on_you', agentStatus: 'waiting_on_you' })
    const q = makeDecision({ id: 'dq', ticketId: ticket.id })
    const p = makeDecision({ id: 'dp', ticketId: ticket.id, kind: 'permission', question: 'Run npm test?', options: [] })
    thread = {
      events: [makeEvent({ kind: 'decision', decisionId: 'dq' }), makeEvent({ kind: 'decision', decisionId: 'dp' })],
      decisions: [q, p],
      runs: [run]
    }
    renderWithMantine(<TicketView />)
    await screen.findByText('Run npm test?')
    await expectNoAxeViolations()
  })
})
