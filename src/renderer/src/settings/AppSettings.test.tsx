import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ThemeChoice, ThemeSetting } from '../../../shared/domain'
import type { UsageTotals } from '../../../shared/usageTotals'
import { invoke } from '../api'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { AppSettings } from './AppSettings'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))
vi.mock('../notify', () => ({ showError: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

let storedTheme: ThemeSetting
let orchestratorUsage: UsageTotals | null = null

beforeEach(() => {
  mockInvoke.mockReset()
  storedTheme = { choice: 'light', light: 'light', dark: 'dark' }
  const settings = () => ({ maxAgents: 3, whenClosed: 'tray', orchestratorWebAccess: true, theme: storedTheme })
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'orchestrator.usage') return orchestratorUsage
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

test('the Usage section shows what the orchestrator used, with the cost labelled, or Not recorded', async () => {
  const { rerender } = renderWithMantine(<AppSettings opened onClose={() => {}} />)
  const drawer = await screen.findByRole('dialog', { name: 'Mainbus settings' })
  expect(await within(within(drawer).getByRole('region', { name: 'Orchestrator usage' })).findByText('Not recorded')).toBeInTheDocument()
  rerender(<AppSettings opened={false} onClose={() => {}} />)
  orchestratorUsage = { inputTokens: 1500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 2, agentMs: 30_000, costUsd: 0.1, models: ['claude-opus-5-5'] }
  rerender(<AppSettings opened onClose={() => {}} />)
  const usage = within(await screen.findByRole('dialog', { name: 'Mainbus settings' })).getByRole('region', { name: 'Orchestrator usage' })
  await vi.waitFor(() => expect(usage.textContent).toContain('1.5k input'))
  expect(usage.textContent).toContain('API-equivalent cost, not billed on your Claude plan')
})

test('the web access switch is in the Orchestrator section, on by default', async () => {
  renderWithMantine(<AppSettings opened onClose={() => {}} />)
  const drawer = await screen.findByRole('dialog', { name: 'Mainbus settings' })
  const section = within(drawer).getByRole('region', { name: 'Orchestrator' })
  const toggle = within(section).getByRole('switch', { name: /^Let the orchestrator read web pages/ })
  await vi.waitFor(() => expect(toggle).toBeEnabled())
  expect(toggle).toBeChecked()
})
