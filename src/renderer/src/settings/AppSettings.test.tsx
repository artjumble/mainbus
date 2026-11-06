import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ThemeChoice, ThemeSetting } from '../../../shared/domain'
import { invoke } from '../api'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { AppSettings } from './AppSettings'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))
vi.mock('../notify', () => ({ showError: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

let storedTheme: ThemeSetting

beforeEach(() => {
  mockInvoke.mockReset()
  storedTheme = { choice: 'light', light: 'light', dark: 'dark' }
  const settings = () => ({ maxAgents: 3, whenClosed: 'tray', theme: storedTheme })
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'settings.get') return settings()
    if (command === 'settings.setTheme') {
      storedTheme = { ...storedTheme, choice: args[0] as ThemeChoice }
      return settings()
    }
    return undefined
  })
})

test('the Mainbus settings hold the Theme under Appearance, and nothing of a workspace', async () => {
  renderWithMantine(<AppSettings opened onClose={() => {}} />)
  const drawer = await screen.findByRole('dialog', { name: 'Mainbus settings' })
  const appearance = within(drawer).getByRole('region', { name: 'Appearance' })
  expect(within(appearance).getByRole('heading', { name: 'Appearance', level: 3 })).toBeInTheDocument()
  const theme = within(appearance).getByRole('radiogroup', { name: 'Theme' })
  await vi.waitFor(() => expect(within(theme).getByRole('radio', { name: 'Light' })).toBeChecked())
  expect(within(theme).getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual(['light', 'dark', 'night-owl', 'light-owl', 'system'])

  await userEvent.click(within(theme).getByRole('radio', { name: 'Night Owl' }))
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setTheme', 'night-owl'))
  expect(within(theme).getByRole('radio', { name: 'Night Owl' })).toBeChecked()

  expect(within(drawer).queryByRole('textbox', { name: 'Agents running at once' })).not.toBeInTheDocument()
  expect(within(drawer).queryByRole('heading', { name: 'Lineup' })).not.toBeInTheDocument()
})

test('loads nothing while closed', () => {
  renderWithMantine(<AppSettings opened={false} onClose={() => {}} />)
  expect(mockInvoke).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog', { name: 'Mainbus settings' })).not.toBeInTheDocument()
})

test('Esc closes it', async () => {
  const onClose = vi.fn()
  renderWithMantine(<AppSettings opened onClose={onClose} />)
  await screen.findByRole('dialog', { name: 'Mainbus settings' })
  await userEvent.keyboard('{Escape}')
  expect(onClose).toHaveBeenCalled()
})

test('the Mainbus settings, with Match Windows open, have no axe violations', async () => {
  storedTheme = { choice: 'system', light: 'light', dark: 'dark' }
  renderWithMantine(<AppSettings opened onClose={() => {}} />)
  await screen.findByRole('radiogroup', { name: 'Dark theme' })
  await expectNoAxeViolations()
})
