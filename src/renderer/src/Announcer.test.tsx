import { act, screen } from '@testing-library/react'
import { Announcer } from './Announcer'
import { useMainbus } from './store'
import { expectNoAxeViolations, makeDecision, makeTicket, renderWithMantine, workspace } from './test-utils'

vi.mock('./api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const initial = useMainbus.getState()
const status = (): HTMLElement => screen.getByRole('status')

function show(tickets: ReturnType<typeof makeTicket>[], ws = workspace): void {
  act(() => useMainbus.setState({ workspace: ws, workspaceLoaded: true, boardLoaded: true, tickets }))
}

beforeEach(() => useMainbus.setState({ ...initial, workspace, workspaceLoaded: true, boardLoaded: true, tickets: [] }, true))

test('what is on the board when it loads is not announced', () => {
  const ticket = makeTicket({ title: 'Old', pendingDecisions: [makeDecision({ id: 'old' })] })
  show([ticket])
  renderWithMantine(<Announcer />)
  expect(status()).toBeEmptyDOMElement()
})

test('a new decision is announced once, and a re-render does not repeat it', () => {
  const ticket = makeTicket({ title: 'Add hello file' })
  show([ticket])
  renderWithMantine(<Announcer />)

  show([{ ...ticket, pendingDecisions: [makeDecision({ id: 'd9', question: 'Where should hello.txt go?' })] }])
  expect(status()).toHaveTextContent(`#${ticket.number} Add hello file needs you: Where should hello.txt go?`)

  // The announcement is cleared by hand to see whether the same decision brings it back.
  const text = status().textContent
  show([{ ...ticket, title: 'Renamed', pendingDecisions: [makeDecision({ id: 'd9', question: 'Where should hello.txt go?' })] }])
  expect(status().textContent).toBe(text)
})

test('switching workspace seeds silently, so its old decisions are not announced', () => {
  const ticket = makeTicket({ title: 'Here' })
  show([ticket])
  renderWithMantine(<Announcer />)
  act(() => useMainbus.setState({ boardLoaded: false }))
  show([makeTicket({ title: 'There', pendingDecisions: [makeDecision({ id: 'other' })] })], { ...workspace, id: 'w2' })
  expect(status()).toBeEmptyDOMElement()
})

test('has no accessibility violations', async () => {
  renderWithMantine(<Announcer />)
  await expectNoAxeViolations()
})
