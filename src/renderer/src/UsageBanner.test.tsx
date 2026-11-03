import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { UsageState } from '../../shared/domain'
import { invoke } from './api'
import { useMainbus } from './store'
import { expectNoAxeViolations, renderWithMantine } from './test-utils'
import { UsageBanner } from './UsageBanner'

vi.mock('./api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
})

// Local times, as the banner shows them.
const reset = new Date(2026, 10, 2, 14, 0).toISOString()

function show(usage: UsageState): void {
  useMainbus.setState({ usage })
  renderWithMantine(<UsageBanner />)
}

test('shows nothing while the limit is not close, but keeps an empty status region for the banner to appear in', () => {
  show({ kind: 'ok' })
  expect(screen.getByRole('status', { name: 'Usage limit' })).toBeEmptyDOMElement()
})

test('the banner appears inside the same status region, so it is announced', () => {
  show({ kind: 'ok' })
  const region = screen.getByRole('status', { name: 'Usage limit' })
  act(() => useMainbus.setState({ usage: { kind: 'warning', resetsAt: reset } }))
  expect(screen.getByRole('status', { name: 'Usage limit' })).toBe(region)
  expect(region).not.toBeEmptyDOMElement()
})

test('when limited it says how many agents are paused and when they resume, with a Resume now button', async () => {
  mockInvoke.mockResolvedValue(undefined)
  show({ kind: 'limited', resetsAt: reset, retryAt: null, paused: 3 })
  expect(screen.getByRole('status')).toHaveTextContent('Usage limit reached. 3 agents paused; resuming at 14:00.')

  await userEvent.click(screen.getByRole('button', { name: 'Resume now' }))
  expect(mockInvoke).toHaveBeenCalledWith('usage.resumeNow')
})

test('when the reset is unknown it says when Mainbus tries again', () => {
  show({ kind: 'limited', resetsAt: null, retryAt: new Date(2026, 10, 2, 14, 15).toISOString(), paused: 1 })
  expect(screen.getByRole('status')).toHaveTextContent('Usage limit reached. 1 agent paused; trying again at 14:15.')
})

test('near the limit it warns that new agents wait, with no button', () => {
  show({ kind: 'warning', resetsAt: reset })
  expect(screen.getByRole('status')).toHaveTextContent('Close to the usage limit: new agents wait until it resets at 14:00.')
  expect(screen.queryByRole('button', { name: 'Resume now' })).not.toBeInTheDocument()
})

test('has no accessibility violations, limited or close', async () => {
  show({ kind: 'limited', resetsAt: reset, retryAt: null, paused: 3 })
  await expectNoAxeViolations()
})
