import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { expectNoAxeViolations, makeDecision, renderWithMantine } from '../test-utils'
import { DecisionCard } from './DecisionCard'

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

test('DecisionCard answers with the chosen option and note', async () => {
  renderWithMantine(<DecisionCard decision={makeDecision()} />)
  expect(screen.getByText('Which database?')).toBeInTheDocument()
  const answer = screen.getByRole('button', { name: 'Answer' })
  expect(answer).toBeDisabled()
  await userEvent.click(screen.getByRole('radio', { name: 'Postgres' }))
  await userEvent.type(screen.getByRole('textbox', { name: /Note/ }), 'because scale')
  await userEvent.click(answer)
  expect(mockInvoke).toHaveBeenCalledWith('decision.answer', 'd1', { kind: 'option', index: 1, note: 'because scale' }, 'thread')
})

test('a note is optional and omitted when blank', async () => {
  renderWithMantine(<DecisionCard decision={makeDecision()} />)
  await userEvent.click(screen.getByRole('radio', { name: 'SQLite' }))
  await userEvent.click(screen.getByRole('button', { name: 'Answer' }))
  expect(mockInvoke).toHaveBeenCalledWith('decision.answer', 'd1', { kind: 'option', index: 0 }, 'thread')
})

test('the recommended option is marked', () => {
  renderWithMantine(<DecisionCard decision={makeDecision({ recommended: 1 })} />)
  expect(screen.getByText('Recommended')).toBeInTheDocument()
})

test('an answered card shows the chosen option and no controls', () => {
  const decision = makeDecision({ status: 'answered', answer: { kind: 'option', index: 1, note: 'scale' } })
  renderWithMantine(<DecisionCard decision={decision} />)
  expect(screen.getByText('✓ Answered: Postgres')).toBeInTheDocument()
  expect(screen.getByText('scale')).toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

test('a cancelled or expired question has no controls', () => {
  const { unmount } = renderWithMantine(<DecisionCard decision={makeDecision({ status: 'cancelled' })} />)
  expect(screen.getByText('Cancelled')).toBeInTheDocument()
  unmount()
  renderWithMantine(<DecisionCard decision={makeDecision({ status: 'expired' })} />)
  expect(screen.getByText(/^Expired/)).toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

test('a failed answer is shown and the card stays answerable', async () => {
  mockInvoke.mockRejectedValue(new Error("Error invoking remote method 'engine:invoke': Error: Already answered"))
  renderWithMantine(<DecisionCard decision={makeDecision()} />)
  await userEvent.click(screen.getByRole('radio', { name: 'SQLite' }))
  await userEvent.click(screen.getByRole('button', { name: 'Answer' }))
  expect(await screen.findByText('Already answered')).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Answer' })).toBeEnabled())
})

test('a setup error asks for a restart', async () => {
  mockInvoke.mockRejectedValue(new Error('Error invoking remote method: SetupRequiredError: Claude Code is not set up'))
  renderWithMantine(<DecisionCard decision={makeDecision()} />)
  await userEvent.click(screen.getByRole('radio', { name: 'SQLite' }))
  await userEvent.click(screen.getByRole('button', { name: 'Answer' }))
  expect(await screen.findByText(/Restart Mainbus/)).toBeInTheDocument()
})

test.each([
  ['pending', {}],
  ['recommended', { recommended: 1 }],
  ['answered', { status: 'answered', answer: { kind: 'option', index: 0 } }],
  ['expired', { status: 'expired' }]
] as const)('a %s card has no axe violations', async (_name, over) => {
  renderWithMantine(<DecisionCard decision={makeDecision(over as never)} />)
  await expectNoAxeViolations()
})
