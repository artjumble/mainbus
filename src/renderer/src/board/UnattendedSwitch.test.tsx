import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { UnattendedState } from '../../../shared/domain'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { renderWithMantine } from '../test-utils'
import { UnattendedSwitch, unattendedText } from './UnattendedSwitch'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
})

function show(state: UnattendedState): void {
  useMainbus.setState({ unattended: state })
  renderWithMantine(<UnattendedSwitch />)
}

test('the status line says what the mode is doing', () => {
  expect(unattendedText({ kind: 'off' })).toBe('Off')
  expect(unattendedText({ kind: 'working', ticketNumber: 4 })).toBe('Working on #4')
  expect(unattendedText({ kind: 'stopped', reason: 'Ready is empty' })).toBe('Stopped: Ready is empty')
  const until = new Date(2026, 9, 31, 7, 5).toISOString()
  expect(unattendedText({ kind: 'waiting', ticketNumber: 4, until })).toBe('Waiting for the usage limit to reset at 07:05')
})

test('the switch shows the state and asks the engine to switch on', async () => {
  mockInvoke.mockResolvedValue({ on: true, status: { kind: 'starting' } })
  show({ on: false, status: { kind: 'stopped', reason: '3 tickets failed in a row: boom' } })
  expect(screen.getByTestId('unattended-status')).toHaveTextContent('Stopped: 3 tickets failed in a row: boom')
  const toggle = screen.getByRole('switch', { name: 'Unattended' })
  expect(toggle).not.toBeChecked()

  await userEvent.click(toggle)
  expect(mockInvoke).toHaveBeenCalledWith('unattended.set', true)
})

test('an on switch shows the ticket and switches off', async () => {
  mockInvoke.mockResolvedValue({ on: false, status: { kind: 'off' } })
  show({ on: true, status: { kind: 'working', ticketNumber: 2 } })
  expect(screen.getByTestId('unattended-status')).toHaveTextContent('Working on #2')
  const toggle = screen.getByRole('switch', { name: 'Unattended' })
  expect(toggle).toBeChecked()
  await userEvent.click(toggle)
  expect(mockInvoke).toHaveBeenCalledWith('unattended.set', false)
})
