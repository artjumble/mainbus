import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { GeneralSettings } from './GeneralSettings'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))
vi.mock('../notify', () => ({ showError: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

let stored: number
let storedClose: 'tray' | 'quit'
let storedTheme: 'light' | 'dark' | 'system'

beforeEach(() => {
  mockInvoke.mockReset()
  stored = 3
  storedClose = 'tray'
  storedTheme = 'light'
  const settings = () => ({ maxAgents: stored, whenClosed: storedClose, theme: storedTheme })
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'settings.get') return settings()
    if (command === 'settings.setMaxAgents') {
      stored = args[0] as number
      return settings()
    }
    if (command === 'settings.setWhenClosed') {
      storedClose = args[0] as 'tray' | 'quit'
      return settings()
    }
    if (command === 'settings.setTheme') {
      storedTheme = args[0] as 'light' | 'dark' | 'system'
      return settings()
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

test('the theme is Light by default, and offers Dark and Match Windows', async () => {
  renderWithMantine(<GeneralSettings opened />)
  const group = await screen.findByRole('radiogroup', { name: 'Theme' })
  const light = within(group).getByRole('radio', { name: 'Light' })
  await vi.waitFor(() => expect(light).toBeChecked())
  expect(within(group).getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual(['light', 'dark', 'system'])

  await userEvent.click(within(group).getByRole('radio', { name: 'Dark' }))
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setTheme', 'dark'))
  expect(storedTheme).toBe('dark')
  expect(within(group).getByRole('radio', { name: 'Dark' })).toBeChecked()

  await userEvent.click(within(group).getByRole('radio', { name: 'Match Windows' }))
  await vi.waitFor(() => expect(storedTheme).toBe('system'))
  expect(within(group).getByRole('radio', { name: 'Match Windows' })).toBeChecked()
})

test('shows the stored theme', async () => {
  storedTheme = 'system'
  renderWithMantine(<GeneralSettings opened />)
  await vi.waitFor(() => expect(screen.getByRole('radio', { name: 'Match Windows' })).toBeChecked())
})

test('a theme that cannot be saved goes back to the one before', async () => {
  renderWithMantine(<GeneralSettings opened />)
  const light = await screen.findByRole('radio', { name: 'Light' })
  await vi.waitFor(() => expect(light).toBeChecked())
  mockInvoke.mockImplementationOnce(async () => {
    throw new Error('disk full')
  })
  await userEvent.click(screen.getByRole('radio', { name: 'Dark' }))
  await vi.waitFor(() => expect(light).toBeChecked())
  expect(storedTheme).toBe('light')
})

test('the general settings have no axe violations', async () => {
  renderWithMantine(<GeneralSettings opened />)
  await field()
  await expectNoAxeViolations()
})
