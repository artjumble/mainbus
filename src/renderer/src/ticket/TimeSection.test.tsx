import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { ticketTime, type TicketTime } from '../../../shared/timeBreakdown'
import { expectNoAxeViolations, makeEvent, renderWithMantine } from '../test-utils'
import { TimeSection } from './TimeSection'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(() => () => {}), openFolder: vi.fn() }))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

const T0 = Date.UTC(2026, 0, 1, 10)
const iso = (min: number): string => new Date(T0 + min * 60_000).toISOString()
const runs = {
  a: { id: 'a', ticketRunId: 't1', role: 'Planner' },
  b: { id: 'b', ticketRunId: 't1', role: 'Implementer' }
}

function sampleTime(): TicketTime {
  const call = { kind: 'tool_call' as const, id: 'x', name: 'Bash', input: { command: 'pnpm test' } }
  return ticketTime({
    runs: [
      { id: 'a', ticketRunId: 't1', role: 'Planner', startedAt: iso(0), endedAt: iso(5) },
      { id: 'b', ticketRunId: 't1', role: 'Implementer', startedAt: iso(5), endedAt: iso(45) }
    ],
    events: [
      { runId: 'b', seq: 1, at: iso(10), event: call },
      { runId: 'b', seq: 2, at: iso(41), event: { kind: 'tool_result', id: 'x', ok: true, summary: '' } }
    ],
    decisions: [],
    ticketRuns: [{ id: 't1', status: 'done', endedAt: iso(45) }],
    now: T0
  })
}

beforeEach(() => {
  mockInvoke.mockReset()
  mockInvoke.mockResolvedValue(sampleTime())
})

const events = [makeEvent({ kind: 'message', text: 'hi' }, { runId: 'a' })]

test('collapsed by default, and it asks the engine only when opened', async () => {
  renderWithMantine(<TimeSection ticketId="t" events={events} runs={runs} />)
  const section = screen.getByRole('region', { name: 'Time' })
  expect(within(section).getByRole('button', { name: 'Show' })).toHaveAttribute('aria-expanded', 'false')
  expect(mockInvoke).not.toHaveBeenCalled()
  await userEvent.click(within(section).getByRole('button', { name: 'Show' }))
  expect(mockInvoke).toHaveBeenCalledWith('ticket.time', 't')
})

test('shows the total, a bar per role with its categories, and the longest commands', async () => {
  const { container } = renderWithMantine(<TimeSection ticketId="t" events={events} runs={runs} />)
  await userEvent.click(screen.getByRole('button', { name: 'Show' }))
  const section = screen.getByRole('region', { name: 'Time' })
  expect(await within(section).findByText(/45 min in 1 run and 2 roles · 45 min from the first start to Review/)).toBeVisible()
  const bars = within(section).getAllByRole('img')
  expect(bars.map((b) => b.getAttribute('aria-label'))).toEqual([
    'Planner: Between turns or roles 5 min',
    'Implementer: Tests 31 min, Between turns or roles 5 min, Model 4 min'
  ])
  expect(bars[1]!.querySelector('[data-category="tests"]')).not.toBeNull()
  expect(within(section).getByText('pnpm test × 1, 31 min')).toBeVisible()
  await expectNoAxeViolations(container)
})

test('nothing shows before the first run', () => {
  renderWithMantine(<TimeSection ticketId="t" events={[]} runs={{}} />)
  expect(screen.queryByRole('region', { name: 'Time' })).not.toBeInTheDocument()
})
