import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactElement } from 'react'
import type { EngineEvent } from '../../../shared/api'
import type { OrchestratorThread, StoredEvent, ThreadEvent } from '../../../shared/events'
import type { Proposal } from '../../../shared/proposals'
import { invoke, onEngineEvent } from '../api'
import { useMainbus } from '../store'
import { makeTicket, renderWithMantine } from '../test-utils'
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
  useMainbus.setState({
    tickets: [makeTicket({}, { column: 'needs_you' }), makeTicket({}, { column: 'needs_you' }), makeTicket({}, { column: 'ready' })]
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
