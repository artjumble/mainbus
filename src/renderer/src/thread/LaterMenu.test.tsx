import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { laterMonday, laterTomorrow } from '../../../shared/hold'
import { TicketCard } from '../board/TicketCard'
import { invoke } from '../api'
import { makeDecision, makeTicket, renderWithMantine } from '../test-utils'
import { DecisionCard } from './DecisionCard'
import { PermissionCard } from './PermissionCard'

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

/** The date `decision.defer` was last invoked with. */
function deferredTo(id = 'd1'): Date {
  const call = mockInvoke.mock.calls.find((c) => c[0] === 'decision.defer' && c[1] === id)
  expect(call).toBeDefined()
  return new Date(call![2] as string)
}

async function pick(item: string): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'Later…' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: item }))
}

const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()

describe.each([
  ['question card', () => <DecisionCard decision={makeDecision()} />],
  ['permission card', () => <PermissionCard decision={makeDecision({ kind: 'permission', question: 'Run npm test?', options: [] })} />]
])('Later… on the %s', (_name, card) => {
  test('Tomorrow defers to 09:00 tomorrow', async () => {
    renderWithMantine(card())
    await pick('Tomorrow')
    const until = deferredTo()
    expect(sameDay(until, laterTomorrow(new Date()))).toBe(true)
    expect(until.getHours()).toBe(9)
  })

  test('Monday defers to 09:00 on the next Monday', async () => {
    renderWithMantine(card())
    await pick('Monday')
    const until = deferredTo()
    expect(sameDay(until, laterMonday(new Date()))).toBe(true)
    expect([until.getDay(), until.getHours()]).toEqual([1, 9])
  })

  test('Pick a date shows a date input here and defers to 09:00 on that day', async () => {
    renderWithMantine(card())
    await pick('Pick a date')
    const input = await screen.findByLabelText('Put off until')
    await userEvent.clear(input)
    await userEvent.type(input, '2099-03-04')
    await userEvent.click(screen.getByRole('button', { name: 'Defer' }))
    expect(deferredTo()).toEqual(new Date(2099, 2, 4, 9, 0))
  })

  test('Pick a date refuses a day that has passed', async () => {
    renderWithMantine(card())
    await pick('Pick a date')
    const input = await screen.findByLabelText('Put off until')
    await userEvent.clear(input)
    await userEvent.type(input, '2020-01-01')
    expect(screen.getByRole('button', { name: 'Defer' })).toBeDisabled()
  })
})

test('a deferred thread card says when it comes back, and keeps its answer controls but not Later…', async () => {
  const until = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
  renderWithMantine(<DecisionCard decision={makeDecision({ status: 'deferred', deferredUntil: until })} />)
  expect(screen.getByText(/^Deferred until /)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Later…' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('radio', { name: 'SQLite' }))
  await userEvent.click(screen.getByRole('button', { name: 'Answer' }))
  expect(mockInvoke).toHaveBeenCalledWith('decision.answer', 'd1', { kind: 'option', index: 0 }, 'thread')
})

test('a deferred permission card keeps its choices', () => {
  const until = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
  renderWithMantine(
    <PermissionCard decision={makeDecision({ kind: 'permission', options: [], status: 'deferred', deferredUntil: until })} />
  )
  expect(screen.getByText(/^Deferred until /)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Allow once' })).toBeInTheDocument()
})

test('Later… in the board popover defers, closes the popover and does not open the ticket', async () => {
  const onOpen = vi.fn()
  const waiting = { column: 'needs_you', phase: 'waiting_on_you', agentStatus: 'waiting_on_you', summary: 'Which database?' } as const
  renderWithMantine(<TicketCard ticket={makeTicket({ pendingDecisions: [makeDecision()] }, waiting)} onOpen={onOpen} />)
  await userEvent.click(screen.getByRole('button', { name: 'Answer' }))
  await pick('Tomorrow')
  expect(sameDay(deferredTo(), laterTomorrow(new Date()))).toBe(true)
  await waitFor(() => expect(screen.queryByRole('radio', { name: 'SQLite' })).not.toBeInTheDocument())
  expect(onOpen).not.toHaveBeenCalled()
})

test('a refused deferral keeps the card open', async () => {
  mockInvoke.mockRejectedValue(new Error('Already deferred'))
  renderWithMantine(<DecisionCard decision={makeDecision()} />)
  await pick('Tomorrow')
  await waitFor(() => expect(mockInvoke).toHaveBeenCalled())
  expect(screen.getByRole('radio', { name: 'SQLite' })).toBeInTheDocument()
})
