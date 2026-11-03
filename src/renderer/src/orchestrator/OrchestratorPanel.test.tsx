import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactElement } from 'react'
import type { EngineEvent } from '../../../shared/api'
import type { Decision } from '../../../shared/domain'
import type { OrchestratorThread, StoredEvent, ThreadEvent } from '../../../shared/events'
import type { Proposal } from '../../../shared/proposals'
import { invoke, onEngineEvent } from '../api'
import { useMainbus, type BoardTicket } from '../store'
import { expectNoAxeViolations, makeDecision, makeTicket, renderWithMantine, workspace } from '../test-utils'
import { EMPTY_TEXT, OrchestratorPanel } from './OrchestratorPanel'
import { readPanelOpen, writePanelOpen } from './panelState'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), isSetupRequired: () => false }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()
let emit: (e: EngineEvent) => void

let seq = 0
const ev = (event: ThreadEvent): StoredEvent => ({ runId: 'o1', seq: ++seq, at: '2026-11-01T10:00:00.000Z', event })

function history(events: StoredEvent[] = [], status: OrchestratorThread['status'] = 'idle', proposals: Proposal[] = []): void {
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'orchestrator.get') {
      return {
        status,
        runs: [{ id: 'o1', startedAt: '', endedAt: null, endReason: null }],
        events,
        proposals
      } satisfies OrchestratorThread
    }
    return undefined
  })
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    workspaceId: 'ws',
    orchestratorRunId: 'o1',
    kind: 'create_tickets',
    origin: 'orchestrator',
    payload: { intent: 'Add login', tickets: [{ title: 'Login', spec: 'A form', criteria: [], labels: [] }], column: 'backlog' },
    evidence: null,
    status: 'pending',
    result: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    decidedAt: null,
    ...over
  }
}

/** The panel as App holds it: open or collapsed, remembered. */
function Panel(): ReactElement {
  const [open, setOpen] = useState(readPanelOpen)
  return (
    <OrchestratorPanel
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        writePanelOpen(o)
      }}
    />
  )
}

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  localStorage.clear()
  vi.mocked(onEngineEvent).mockImplementation((listener) => {
    emit = listener
    return () => {}
  })
})

test('an empty thread invites the first message', async () => {
  history()
  renderWithMantine(<Panel />)
  expect(await screen.findByText(EMPTY_TEXT)).toBeInTheDocument()
  expect(EMPTY_TEXT).toBe("Ask me to draft tickets, or about what's happening on the board.")
})

test('it collapses to a strip with the needs-you count, expands on click, and remembers which it was', async () => {
  history()
  // Counted across workspaces, whichever one is on the board.
  useMainbus.setState({
    workspaces: [
      { ...workspace, active: false, needsYou: 1, working: 0, waiting: 0, idle: 0 },
      { ...workspace, id: 'w2', name: 'other', active: true, needsYou: 1, working: 0, waiting: 0, idle: 0 }
    ]
  })
  const { unmount } = renderWithMantine(<Panel />)
  await screen.findByText(EMPTY_TEXT)

  await userEvent.click(screen.getByRole('button', { name: 'Collapse orchestrator panel' }))
  const strip = screen.getByRole('button', { name: 'Open orchestrator (2 need you)' })
  expect(strip).toHaveTextContent('2')
  expect(screen.queryByText(EMPTY_TEXT)).not.toBeInTheDocument()
  expect(readPanelOpen()).toBe(false)

  // A restart starts collapsed.
  unmount()
  renderWithMantine(<Panel />)
  await userEvent.click(screen.getByRole('button', { name: 'Open orchestrator (2 need you)' }))
  expect(await screen.findByText(EMPTY_TEXT)).toBeInTheDocument()
  expect(readPanelOpen()).toBe(true)
})

test('sending passes the text to the orchestrator', async () => {
  history()
  renderWithMantine(<Panel />)
  await screen.findByText(EMPTY_TEXT)
  await userEvent.type(screen.getByRole('textbox', { name: 'Message the orchestrator' }), 'hi{Enter}')
  expect(mockInvoke).toHaveBeenCalledWith('orchestrator.send', 'hi')
  expect(screen.getByRole('textbox', { name: 'Message the orchestrator' })).toHaveValue('')
})

test('a failed send keeps the text and says why', async () => {
  history()
  renderWithMantine(<Panel />)
  await screen.findByText(EMPTY_TEXT)
  mockInvoke.mockRejectedValueOnce(new Error('No workspace'))
  await userEvent.type(screen.getByRole('textbox', { name: 'Message the orchestrator' }), 'hi{Enter}')
  expect(await screen.findByText('Could not send')).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Message the orchestrator' })).toHaveValue('hi')
})

test('while a turn runs, a Working line shows and Stop interrupts it', async () => {
  history()
  renderWithMantine(<Panel />)
  await screen.findByText(EMPTY_TEXT)
  expect(screen.queryByText('Working…')).not.toBeInTheDocument()

  act(() => emit({ type: 'orchestrator.status', status: 'working' }))
  expect(screen.getByText('Working…')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
  expect(mockInvoke).toHaveBeenCalledWith('orchestrator.stop')

  act(() => emit({ type: 'orchestrator.status', status: 'idle' }))
  expect(screen.queryByText('Working…')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
})

test('a status that arrives while the history loads is applied after it', async () => {
  let answer: (t: OrchestratorThread) => void = () => {}
  mockInvoke.mockImplementation(
    (command: string) => (command === 'orchestrator.get' ? new Promise((r) => (answer = r)) : Promise.resolve(undefined))
  )
  renderWithMantine(<Panel />)
  act(() => emit({ type: 'orchestrator.status', status: 'working' }))
  await act(async () => answer({ status: 'idle', runs: [], events: [], proposals: [] }))
  expect(screen.getByText('Working…')).toBeInTheDocument()
})

test('a proposal shows as its card where it was proposed, and follows its changes', async () => {
  history([ev({ kind: 'user_message', text: 'Add login' }), ev({ kind: 'proposal', proposalId: 'p1' })], 'idle', [proposal()])
  renderWithMantine(<Panel />)
  const card = await screen.findByRole('group', { name: 'Proposal: Create 1 ticket in Backlog' })
  expect(card).toHaveTextContent('Login')

  act(() =>
    emit({
      type: 'proposal.changed',
      proposal: proposal({ status: 'confirmed', result: { tickets: [{ id: 't1', number: 4, title: 'Login' }], column: 'backlog' } })
    })
  )
  expect(screen.queryByRole('group', { name: /^Proposal:/ })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '#4' })).toBeInTheDocument()
})

test('a proposal event that arrives before its proposal shows a loader until it does', async () => {
  history([ev({ kind: 'user_message', text: 'Add login' })])
  renderWithMantine(<Panel />)
  await screen.findByText('Add login')
  act(() => emit({ type: 'orchestrator.appended', event: ev({ kind: 'proposal', proposalId: 'p1' }) }))
  expect(screen.getByLabelText('Loading the proposal')).toBeInTheDocument()
  act(() => emit({ type: 'proposal.changed', proposal: proposal() }))
  expect(screen.queryByLabelText('Loading the proposal')).not.toBeInTheDocument()
  expect(screen.getByRole('group', { name: 'Proposal: Create 1 ticket in Backlog' })).toBeInTheDocument()
})

test('the thread shows messages as markdown, a thinking stub, summarised tools, notices and errors', async () => {
  history([
    ev({ kind: 'user_message', text: 'What is on the board?' }),
    ev({ kind: 'thinking', text: null }),
    ev({ kind: 'tool_call', id: 'c1', name: 'mcp__mainbus__list_tickets', input: {} }),
    ev({ kind: 'tool_result', id: 'c1', ok: true, summary: '3 tickets' }),
    ev({ kind: 'message', text: 'There are **three** tickets.' }),
    ev({ kind: 'notice', text: 'The last session could not be resumed, so this is a fresh one.' }),
    ev({ kind: 'error', message: 'The orchestrator stopped unexpectedly' })
  ])
  renderWithMantine(<Panel />)
  expect(await screen.findByText('What is on the board?')).toBeInTheDocument()
  expect(screen.getByText('three').tagName).toBe('STRONG')
  expect(screen.getByText('Thought')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Looked at the board/ })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('The last session could not be resumed, so this is a fresh one.')).toBeInTheDocument()
  expect(screen.getByText('The orchestrator stopped unexpectedly')).toBeInTheDocument()
  expect(screen.queryByText(EMPTY_TEXT)).not.toBeInTheDocument()
})

test('live events are added to the thread, from a session it had not seen', async () => {
  history()
  renderWithMantine(<Panel />)
  await screen.findByText(EMPTY_TEXT)
  act(() =>
    emit({
      type: 'orchestrator.appended',
      event: { runId: 'o2', seq: 1, at: '2026-11-01T10:00:00.000Z', event: { kind: 'message', text: 'Hello *there*' } }
    })
  )
  expect(screen.getByText('there').tagName).toBe('EM')
  expect(screen.getByText('ORCHESTRATOR')).toBeInTheDocument()
})

test('a revealed proposal is scrolled into view once, as its card arrives', async () => {
  const scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView
  history([ev({ kind: 'proposal', proposalId: 'p1', from: 'drag' })], 'idle', [proposal()])
  renderWithMantine(<OrchestratorPanel open onOpenChange={() => {}} />)
  await screen.findByRole('group', { name: /Proposal:/ })
  expect(scrollIntoView).not.toHaveBeenCalled()

  act(() => useMainbus.getState().revealProposal('p1'))
  await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
  // Other renders don't scroll again; a second reveal does.
  act(() => emit({ type: 'orchestrator.status', status: 'working' }))
  expect(scrollIntoView).toHaveBeenCalledTimes(1)
  act(() => useMainbus.getState().revealProposal('p1'))
  await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2))
})

describe('Waiting on you', () => {
  const decision = (id: string, createdAt: string, over: Partial<Decision> = {}): Decision => ({
    id,
    deferredUntil: null,
    ticketId: 't',
    agentRunId: 'r',
    kind: 'question',
    question: `Question ${id}?`,
    options: ['Yes', 'No'],
    recommended: null,
    allowAlways: true,
    status: 'pending',
    answer: null,
    createdAt,
    answeredAt: null,
    answeredBy: null,
    answeredVia: null,
    ...over
  })

  function board(): { a: BoardTicket; b: BoardTicket } {
    const a = makeTicket(
      { title: 'Login', pendingDecisions: [decision('late', '2026-11-01T12:00:00.000Z')] },
      { column: 'needs_you' }
    )
    const b = makeTicket(
      {
        title: 'Logout',
        pendingDecisions: [decision('early', '2026-11-01T11:00:00.000Z', { kind: 'permission', options: [] })],
        lineup: [{ id: 'r1', name: 'Reviewer', status: 'working', active: true, replacements: 0 }]
      },
      { column: 'needs_you' }
    )
    useMainbus.setState({ tickets: [a, b] })
    return { a, b }
  }

  test('lists every pending decision oldest first, each linking to its ticket', async () => {
    history()
    const { a, b } = board()
    renderWithMantine(<Panel />)
    const group = await screen.findByRole('region', { name: 'Waiting on you' })
    const cards = within(group).getAllByText(/^Question /)
    expect(cards.map((c) => c.textContent)).toEqual(['Question early?', 'Question late?'])
    expect(within(group).getByText(/Reviewer/)).toBeInTheDocument()
    await userEvent.click(within(group).getByRole('button', { name: `#${a.number} Login` }))
    expect(useMainbus.getState().currentTicketId).toBe(a.id)
    expect(within(group).getByRole('button', { name: `#${b.number} Logout` })).toBeInTheDocument()
  })

  test('answers one via the orchestrator, and drops one answered elsewhere; hides when empty', async () => {
    history()
    const { a, b } = board()
    renderWithMantine(<Panel />)
    const group = await screen.findByRole('region', { name: 'Waiting on you' })

    await userEvent.click(within(group).getByRole('radio', { name: 'No' }))
    await userEvent.click(within(group).getByRole('button', { name: 'Answer' }))
    expect(mockInvoke).toHaveBeenCalledWith('decision.answer', 'late', { kind: 'option', index: 1 }, 'orchestrator')

    // The engine's board now has it answered; the permission one was answered on the board.
    act(() => useMainbus.setState({ tickets: [{ ...a, pendingDecisions: [] }, b] }))
    expect(within(group).queryByText('Question late?')).not.toBeInTheDocument()
    await userEvent.click(within(group).getByRole('button', { name: 'Deny' }))
    expect(mockInvoke).toHaveBeenCalledWith('decision.answer', 'early', { kind: 'permission', choice: 'deny' }, 'orchestrator')

    act(() => useMainbus.setState({ tickets: [{ ...a, pendingDecisions: [] }, { ...b, pendingDecisions: [] }] }))
    expect(screen.queryByRole('region', { name: 'Waiting on you' })).not.toBeInTheDocument()
  })
})

describe('Deferred group', () => {
  const until = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
  const deferred = (id: string, over: Partial<Decision> = {}): Decision =>
    makeDecision({ id, question: `Question ${id}?`, status: 'deferred', deferredUntil: until, ...over })

  function board(): BoardTicket {
    const t = makeTicket(
      { title: 'Login', deferredDecisions: [deferred('a'), deferred('b', { kind: 'permission', options: [] })] },
      { column: 'in_progress', phase: 'waiting_on_you', agentStatus: 'waiting_on_you', deferredUntil: until }
    )
    useMainbus.setState({ tickets: [t] })
    return t
  }

  test('starts collapsed with its count, and shows no Waiting on you part when none is pending', async () => {
    history()
    board()
    renderWithMantine(<Panel />)
    const toggle = await screen.findByRole('button', { name: /Deferred \(2\)/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region', { name: 'Waiting on you' })).not.toBeInTheDocument()
    expect(screen.getByText('Question a?')).not.toBeVisible()
  })

  test('expanded, lists each entry with its date and answers via the orchestrator', async () => {
    history()
    board()
    renderWithMantine(<Panel />)
    await userEvent.click(await screen.findByRole('button', { name: /Deferred \(2\)/ }))
    const group = screen.getByRole('region', { name: 'Deferred' })
    expect(screen.getByRole('button', { name: /Deferred \(2\)/ })).toHaveAttribute('aria-expanded', 'true')
    expect(within(group).getAllByText(/^Until /)).toHaveLength(2)
    expect(within(group).getByText('Question a?')).toBeInTheDocument()
    expect(within(group).queryByRole('button', { name: 'Later…' })).not.toBeInTheDocument()

    await userEvent.click(await within(group).findByRole('radio', { name: 'Postgres' }))
    await userEvent.click(within(group).getByRole('button', { name: 'Answer' }))
    expect(mockInvoke).toHaveBeenCalledWith('decision.answer', 'a', { kind: 'option', index: 1 }, 'orchestrator')
    await userEvent.click(within(group).getByRole('button', { name: 'Deny' }))
    expect(mockInvoke).toHaveBeenCalledWith('decision.answer', 'b', { kind: 'permission', choice: 'deny' }, 'orchestrator')
  })

  test('Bring back now invokes decision.bringBack', async () => {
    history()
    board()
    renderWithMantine(<Panel />)
    await userEvent.click(await screen.findByRole('button', { name: /Deferred \(2\)/ }))
    const group = screen.getByRole('region', { name: 'Deferred' })
    await userEvent.click((await within(group).findAllByRole('button', { name: 'Bring back now' }))[0]!)
    expect(mockInvoke).toHaveBeenCalledWith('decision.bringBack', expect.stringMatching(/^[ab]$/))
  })

  test('pending decisions keep their own region above it, with Later…', async () => {
    history()
    const t = board()
    useMainbus.setState({ tickets: [{ ...t, pendingDecisions: [makeDecision({ id: 'p', question: 'Now?' })] }] })
    renderWithMantine(<Panel />)
    const waiting = await screen.findByRole('region', { name: 'Waiting on you' })
    expect(within(waiting).getByText('Now?')).toBeInTheDocument()
    expect(within(waiting).getByRole('button', { name: 'Later…' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Deferred \(2\)/ })).toBeInTheDocument()
  })
})

describe('accessibility', () => {
  test('the open panel, empty, working and with a thread and a proposal, has no axe violations', async () => {
    history([ev({ kind: 'user_message', text: 'Add login' }), ev({ kind: 'message', text: 'Drafting.' }), ev({ kind: 'proposal', proposalId: 'p1' })], 'idle', [proposal()])
    renderWithMantine(<Panel />)
    await screen.findByRole('group', { name: 'Proposal: Create 1 ticket in Backlog' })
    await expectNoAxeViolations()
    act(() => emit({ type: 'orchestrator.status', status: 'working' }))
    expect(screen.getByText('Working…')).toBeInTheDocument()
    await expectNoAxeViolations()
  })

  test('the Working line sits in a status region that is there before it, so it is announced', async () => {
    history()
    renderWithMantine(<Panel />)
    await screen.findByText(EMPTY_TEXT)
    const region = screen.getByRole('status')
    expect(region).toBeEmptyDOMElement()
    act(() => emit({ type: 'orchestrator.status', status: 'working' }))
    expect(within(screen.getByRole('status')).getByText('Working…')).toBeInTheDocument()
    expect(screen.getByRole('status')).toBe(region)
  })

  test('the collapsed strip has no axe violations', async () => {
    history()
    useMainbus.setState({ workspaces: [{ ...workspace, active: true, needsYou: 2, working: 0, waiting: 0, idle: 0 }] })
    renderWithMantine(<Panel />)
    await userEvent.click(await screen.findByRole('button', { name: 'Collapse orchestrator panel' }))
    await expectNoAxeViolations()
  })

  test('Waiting on you and Deferred, expanded, have no axe violations', async () => {
    history()
    const until = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
    const t = makeTicket(
      {
        title: 'Login',
        pendingDecisions: [makeDecision({ id: 'q', question: 'Which database?' })],
        deferredDecisions: [makeDecision({ id: 'a', question: 'Later?', status: 'deferred', deferredUntil: until })]
      },
      { column: 'needs_you', phase: 'waiting_on_you', agentStatus: 'waiting_on_you' }
    )
    useMainbus.setState({ tickets: [t] })
    renderWithMantine(<Panel />)
    await userEvent.click(await screen.findByRole('button', { name: /Deferred \(1\)/ }))
    await screen.findByRole('region', { name: 'Waiting on you' })
    await expectNoAxeViolations()
  })
})
