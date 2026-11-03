import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { SetupScreen } from './SetupScreen'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

function showSetup(reason: 'not_found' | 'not_logged_in' | 'restart_required'): void {
  useMainbus.setState({ ...initial, setup: { ok: false, reason, detail: 'some detail' } }, true)
}

beforeEach(() => mockInvoke.mockReset())

test('SetupScreen explains a missing claude and links the official setup docs', () => {
  showSetup('not_found')
  renderWithMantine(<SetupScreen />)
  expect(screen.getByText(/Claude Code isn't installed/)).toBeInTheDocument()
  const link = screen.getByRole('link', { name: /setup/i })
  expect(link).toHaveAttribute('href', 'https://code.claude.com/docs/en/setup')
  expect(link).toHaveAttribute('target', '_blank')
  expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  expect(screen.queryByText(/npm install/)).not.toBeInTheDocument()
  expect(screen.queryByText('Backlog')).not.toBeInTheDocument()
})

test('SetupScreen explains a missing login', () => {
  showSetup('not_logged_in')
  renderWithMantine(<SetupScreen />)
  expect(screen.getByText('claude auth login')).toBeInTheDocument()
  expect(screen.getByText(/run it yourself/i)).toBeInTheDocument()
  expect(screen.queryByText('Backlog')).not.toBeInTheDocument()
})

test('SetupScreen asks for a restart once Claude was fixed after launch', () => {
  showSetup('restart_required')
  renderWithMantine(<SetupScreen />)
  expect(screen.getByText('Restart Mainbus to use Claude Code.')).toBeInTheDocument()
})

test('Check again re-runs the setup check', async () => {
  showSetup('not_found')
  mockInvoke.mockResolvedValue({ ok: false, reason: 'not_logged_in', detail: '' })
  renderWithMantine(<SetupScreen />)
  await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
  expect(mockInvoke).toHaveBeenCalledWith('setup.check')
  expect(await screen.findByText('claude auth login')).toBeInTheDocument()
})

test.each(['not_found', 'not_logged_in', 'restart_required'] as const)('the %s screen has no axe violations', async (reason) => {
  showSetup(reason)
  renderWithMantine(<SetupScreen />)
  await expectNoAxeViolations()
})
