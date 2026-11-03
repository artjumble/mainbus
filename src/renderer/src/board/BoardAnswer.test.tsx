import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { expectNoAxeViolations, makeDecision, makeTicket, renderWithMantine } from '../test-utils'
import { TicketCard } from './TicketCard'

vi.mock('../api', () => ({
  invoke: vi.fn(),
  onEngineEvent: vi.fn(),
  isSetupRequired: (e: unknown) => e instanceof Error && e.message.includes('SetupRequiredError')
}))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockInvoke.mockReset()
  mockInvoke.mockResolvedValue(undefined)
})

const waiting = { column: 'needs_you', phase: 'waiting_on_you', agentStatus: 'waiting_on_you', summary: 'Which database?' } as const

function card(pendingDecisions = [makeDecision({ recommended: 1 })], onOpen = vi.fn()): ReturnType<typeof vi.fn> {
  renderWithMantine(<TicketCard ticket={makeTicket({ pendingDecisions }, waiting)} onOpen={onOpen} />)
  return onOpen
}

test('the popover shows the question, its options with the recommended one marked, and sends the answer with via board', async () => {
  const onOpen = card()
  await userEvent.click(screen.getByRole('button', { name: 'Answer' }))
  expect(await screen.findByRole('radio', { name: 'SQLite' })).toBeInTheDocument()
  expect(screen.getByText('Recommended')).toBeInTheDocument()
  expect(screen.queryByText(/of \d/)).not.toBeInTheDocument()
  await userEvent.click(await screen.findByRole('radio', { name: /Postgres/ }))
  await userEvent.type(screen.getByRole('textbox', { name: /Note/ }), 'because scale')
  const buttons = screen.getAllByRole('button', { name: 'Answer' })
  await userEvent.click(buttons[buttons.length - 1]!)
  expect(mockInvoke).toHaveBeenCalledWith('decision.answer', 'd1', { kind: 'option', index: 1, note: 'because scale' }, 'board')
  await waitFor(() => expect(screen.queryByRole('radio', { name: /Postgres/ })).not.toBeInTheDocument())
  expect(onOpen).not.toHaveBeenCalled()
})

test('a permission shows Allow once, Always allow and Deny', async () => {
  card([makeDecision({ kind: 'permission', question: 'Run `pnpm install`', options: [] })])
  await userEvent.click(screen.getByRole('button', { name: 'Answer' }))
  expect(await screen.findByText('Run `pnpm install`')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Allow once' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Always allow/ })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
  expect(mockInvoke).toHaveBeenCalledWith('decision.answer', 'd1', { kind: 'permission', choice: 'deny' }, 'board')
})

test('several pending decisions show the oldest first as "1 of 3"', async () => {
  card([
    makeDecision({ id: 'd1', question: 'First?' }),
    makeDecision({ id: 'd2', question: 'Second?' }),
    makeDecision({ id: 'd3', question: 'Third?' })
  ])
  await userEvent.click(screen.getByRole('button', { name: 'Answer' }))
  expect(await screen.findByText('1 of 3')).toBeInTheDocument()
  expect(screen.getByText('First?')).toBeInTheDocument()
  expect(screen.queryByText('Second?')).not.toBeInTheDocument()
})

test('clicking the card itself still opens the ticket', async () => {
  const onOpen = vi.fn()
  renderWithMantine(<TicketCard ticket={makeTicket({ title: 'Pick a store', pendingDecisions: [makeDecision()] }, waiting)} onOpen={onOpen} />)
  await userEvent.click(screen.getByText('Pick a store'))
  expect(onOpen).toHaveBeenCalledTimes(1)
})

test('a card with nothing pending, or outside Needs you, has no Answer control', () => {
  const { unmount } = renderWithMantine(<TicketCard ticket={makeTicket({ pendingDecisions: [] }, waiting)} onOpen={() => {}} />)
  expect(screen.queryByRole('button', { name: 'Answer' })).not.toBeInTheDocument()
  unmount()
  renderWithMantine(
    <TicketCard ticket={makeTicket({ pendingDecisions: [makeDecision()] }, { column: 'in_progress' })} onOpen={() => {}} />
  )
  expect(screen.queryByRole('button', { name: 'Answer' })).not.toBeInTheDocument()
})

test('the open popover has no axe violations', async () => {
  card()
  await userEvent.click(screen.getByRole('button', { name: 'Answer' }))
  await screen.findByRole('radio', { name: 'SQLite' })
  await expectNoAxeViolations()
})

test('Escape closes the popover and focus goes back to the Answer button', async () => {
  const onOpen = card()
  await userEvent.click(screen.getByRole('button', { name: 'Answer' }))
  await screen.findByRole('radio', { name: 'SQLite' })
  await userEvent.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('radio', { name: 'SQLite' })).not.toBeInTheDocument())
  await waitFor(() => expect(screen.getByRole('button', { name: 'Answer' })).toHaveFocus())
  expect(onOpen).not.toHaveBeenCalled()
})
