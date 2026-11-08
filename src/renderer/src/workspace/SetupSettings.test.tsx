import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, renderWithMantine, workspace } from '../test-utils'
import { SetupSettings } from './SetupSettings'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

let saved: { setupCommand: string; setupTimeoutMinutes: number }

beforeEach(() => {
  mockInvoke.mockReset()
  saved = { setupCommand: '', setupTimeoutMinutes: 15 }
  useMainbus.setState({ workspace: { ...workspace, ...saved } })
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'workspace.setSetupSettings') {
      const input = args[0] as { command?: string; timeoutMinutes?: number }
      saved = {
        setupCommand: input.command?.trim() ?? saved.setupCommand,
        setupTimeoutMinutes: input.timeoutMinutes ?? saved.setupTimeoutMinutes
      }
      return { ...workspace, ...saved }
    }
    return undefined
  })
})

const command = (): HTMLElement => screen.getByRole('textbox', { name: 'Setup command for new ticket folders' })
const timeout = (): HTMLElement => screen.getByRole('textbox', { name: 'Timeout (minutes)' })
const save = (): HTMLElement => screen.getByRole('button', { name: 'Save setup' })

test('is empty by default with a 15 minute timeout, and nothing to save', () => {
  renderWithMantine(<SetupSettings opened />)
  expect(command()).toHaveValue('')
  expect(command()).toHaveAttribute('placeholder', 'e.g. pnpm install --frozen-lockfile')
  expect(timeout()).toHaveValue('15')
  expect(save()).toBeDisabled()
})

test('saves the command and the timeout for the workspace', async () => {
  renderWithMantine(<SetupSettings opened />)
  await userEvent.type(command(), '  npm ci  ')
  await userEvent.clear(timeout())
  await userEvent.type(timeout(), '30')
  await userEvent.click(save())

  expect(mockInvoke).toHaveBeenCalledWith('workspace.setSetupSettings', { command: 'npm ci', timeoutMinutes: 30 })
  await vi.waitFor(() => expect(useMainbus.getState().workspace).toMatchObject({ setupCommand: 'npm ci', setupTimeoutMinutes: 30 }))
  await vi.waitFor(() => expect(command()).toHaveValue('npm ci'))
  expect(save()).toBeDisabled()
})

test('holds the timeout to 1 to 60 minutes and will not save an empty one', async () => {
  renderWithMantine(<SetupSettings opened />)
  await userEvent.type(command(), 'npm ci')
  expect(save()).toBeEnabled()

  // The timeout is held to 1 to 60 as it is typed.
  await userEvent.clear(timeout())
  await userEvent.type(timeout(), '90')
  expect(Number((timeout() as HTMLInputElement).value)).toBeLessThanOrEqual(60)
  await userEvent.clear(timeout())
  expect(save()).toBeDisabled()
  expect(mockInvoke).not.toHaveBeenCalled()
})

test('the setup settings have no axe violations', async () => {
  const { container } = renderWithMantine(<SetupSettings opened />)
  await expectNoAxeViolations(container)
})
