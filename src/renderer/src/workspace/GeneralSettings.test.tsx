import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { GeneralSettings } from './GeneralSettings'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))
vi.mock('../notify', () => ({ showError: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

let stored: number
let storedClose: 'tray' | 'quit'

beforeEach(() => {
  mockInvoke.mockReset()
  stored = 3
  storedClose = 'tray'
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'settings.get') return { maxAgents: stored, whenClosed: storedClose }
    if (command === 'settings.setMaxAgents') {
      stored = args[0] as number
      return { maxAgents: stored, whenClosed: storedClose }
    }
    if (command === 'settings.setWhenClosed') {
      storedClose = args[0] as 'tray' | 'quit'
      return { maxAgents: stored, whenClosed: storedClose }
    }
    return undefined
  })
})

const field = (): Promise<HTMLElement> => screen.findByRole('textbox', { name: 'Agents running at once' })

test('shows the number of agents allowed at once, three by default', async () => {
  renderWithMantine(<GeneralSettings opened />)
  const input = await field()
  await vi.waitFor(() => expect(input).toHaveValue('3'))
  expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument()
})

test('changing it saves the new number', async () => {
  renderWithMantine(<GeneralSettings opened />)
  const input = await field()
  await vi.waitFor(() => expect(input).toBeEnabled())
  await userEvent.clear(input)
  expect(mockInvoke).not.toHaveBeenCalledWith('settings.setMaxAgents', expect.anything())
  await userEvent.type(input, '5')
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setMaxAgents', 5))
  expect(stored).toBe(5)
})

test('a number above ten is not accepted', async () => {
  renderWithMantine(<GeneralSettings opened />)
  const input = await field()
  await vi.waitFor(() => expect(input).toBeEnabled())
  await userEvent.clear(input)
  await userEvent.type(input, '11')
  expect(mockInvoke).not.toHaveBeenCalledWith('settings.setMaxAgents', 11)
  expect(stored).not.toBe(11)
})

test('does not load anything while the settings are closed', () => {
  renderWithMantine(<GeneralSettings opened={false} />)
  expect(mockInvoke).not.toHaveBeenCalled()
})

test('closing the window keeps running in the tray by default, and Always quit saves', async () => {
  renderWithMantine(<GeneralSettings opened />)
  const tray = await screen.findByRole('radio', { name: 'Keep running in the tray while agents work' })
  await vi.waitFor(() => expect(tray).toBeChecked())
  await userEvent.click(screen.getByRole('radio', { name: 'Always quit' }))
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setWhenClosed', 'quit'))
  expect(storedClose).toBe('quit')
  expect(screen.getByRole('radio', { name: 'Always quit' })).toBeChecked()
})

test('the general settings have no axe violations', async () => {
  renderWithMantine(<GeneralSettings opened />)
  await field()
  await expectNoAxeViolations()
})
