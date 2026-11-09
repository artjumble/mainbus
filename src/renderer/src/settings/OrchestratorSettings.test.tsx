import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { showError } from '../notify'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { OrchestratorSettings } from './OrchestratorSettings'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))
vi.mock('../notify', () => ({ showError: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const NAME = /^Let the orchestrator read web pages/

let failSave = false

beforeEach(() => {
  mockInvoke.mockReset()
  vi.mocked(showError).mockReset()
  failSave = false
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'settings.get') return { orchestratorWebAccess: true }
    if (command === 'settings.setOrchestratorWebAccess') {
      if (failSave) throw new Error('disk full')
      return { orchestratorWebAccess: args[0] }
    }
    return undefined
  })
})

test('loads nothing while closed', () => {
  renderWithMantine(<OrchestratorSettings opened={false} />)
  expect(mockInvoke).not.toHaveBeenCalled()
})

test('is on by default, and turning it off saves and stays off', async () => {
  renderWithMantine(<OrchestratorSettings opened />)
  const toggle = screen.getByRole('switch', { name: NAME })
  await vi.waitFor(() => expect(toggle).toBeEnabled())
  expect(toggle).toBeChecked()
  await userEvent.click(toggle)
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setOrchestratorWebAccess', false))
  expect(toggle).not.toBeChecked()
})

test('goes back and says so when saving fails', async () => {
  failSave = true
  renderWithMantine(<OrchestratorSettings opened />)
  const toggle = screen.getByRole('switch', { name: NAME })
  await vi.waitFor(() => expect(toggle).toBeEnabled())
  await userEvent.click(toggle)
  await vi.waitFor(() => expect(showError).toHaveBeenCalled())
  expect(toggle).toBeChecked()
})

test('has no accessibility violations', async () => {
  const { container } = renderWithMantine(<OrchestratorSettings opened />)
  await vi.waitFor(() => expect(screen.getByRole('switch', { name: NAME })).toBeEnabled())
  await expectNoAxeViolations(container)
})
