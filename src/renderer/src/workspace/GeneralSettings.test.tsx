import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, renderWithMantine, workspace } from '../test-utils'
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
  useMainbus.setState({ workspace })
  const settings = () => ({ maxAgents: stored, whenClosed: storedClose, orchestratorWebAccess: true, theme: { choice: 'light', light: 'light', dark: 'dark' } })
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'settings.get') return settings()
    if (command === 'settings.setMaxAgents') {
      stored = args[0] as number
      return settings()
    }
    if (command === 'workspace.setUnattendedAtOnce') return { ...workspace, unattendedAtOnce: args[0] as number }
    if (command === 'settings.setWhenClosed') {
      storedClose = args[0] as 'tray' | 'quit'
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

test('the theme is not here: it is in the Mainbus settings', async () => {
  renderWithMantine(<GeneralSettings opened />)
  await vi.waitFor(async () => expect(await field()).toHaveValue('3'))
  expect(screen.queryByRole('radiogroup', { name: 'Theme' })).not.toBeInTheDocument()
  expect(screen.queryByText(/Sarah Drasner/)).not.toBeInTheDocument()
})

test('the general settings have no axe violations', async () => {
  renderWithMantine(<GeneralSettings opened />)
  await field()
  await expectNoAxeViolations()
})

const atOnceField = (): Promise<HTMLElement> => screen.findByRole('textbox', { name: 'Unattended: tickets at once' })

test('shows "Unattended: tickets at once", 1 by default, with help that mentions blocked by', async () => {
  renderWithMantine(<GeneralSettings opened />)
  const input = await atOnceField()
  expect(input).toHaveValue('1')
  expect(screen.getByText(/can conflict/)).toHaveTextContent('"blocked by"')
})

test('changing "tickets at once" saves it and updates the workspace', async () => {
  renderWithMantine(<GeneralSettings opened />)
  const input = await atOnceField()
  await vi.waitFor(() => expect(input).toBeEnabled())
  await userEvent.clear(input)
  expect(mockInvoke).not.toHaveBeenCalledWith('workspace.setUnattendedAtOnce', expect.anything())
  await userEvent.type(input, '2')
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('workspace.setUnattendedAtOnce', 2))
  await vi.waitFor(() => expect(useMainbus.getState().workspace?.unattendedAtOnce).toBe(2))
})

test('"tickets at once" cannot go above the agents-at-once limit', async () => {
  renderWithMantine(<GeneralSettings opened />)
  const input = await atOnceField()
  await vi.waitFor(() => expect(input).toBeEnabled())
  await userEvent.clear(input)
  await userEvent.type(input, '4')
  expect(mockInvoke).not.toHaveBeenCalledWith('workspace.setUnattendedAtOnce', 4)
})

test('"Archive Done tickets after" is Off by default; choosing 14 days saves it and updates the workspace', async () => {
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'workspace.setAutoArchiveDays') return { ...workspace, autoArchiveDays: args[0] as 14 | null }
    if (command === 'settings.get') return { maxAgents: 3, whenClosed: 'tray', orchestratorWebAccess: true, theme: { choice: 'light', light: 'light', dark: 'dark' } }
    return undefined
  })
  renderWithMantine(<GeneralSettings opened />)
  const select = await screen.findByRole('combobox', { name: 'Archive Done tickets after' })
  expect(select).toHaveValue('Off')

  await userEvent.click(select)
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Off', '7 days', '14 days', '30 days', '90 days'])
  await userEvent.click(screen.getByRole('option', { name: '14 days' }))

  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('workspace.setAutoArchiveDays', 14))
  await vi.waitFor(() => expect(useMainbus.getState().workspace?.autoArchiveDays).toBe(14))
})
