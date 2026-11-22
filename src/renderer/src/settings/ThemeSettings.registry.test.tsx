import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { THEMES, type ThemeInfo } from '../../../shared/domain'
import { invoke } from '../api'
import { renderWithMantine } from '../test-utils'
import { themes } from '../theme'
import { ThemeSettings } from './ThemeSettings'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))
vi.mock('../notify', () => ({ showError: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const fake = { id: 'test-dusk', name: 'Test Dusk', scheme: 'dark', ground: '#101010' } as unknown as ThemeInfo
const registry = THEMES as unknown as ThemeInfo[]
const colors = themes as unknown as Record<string, unknown>

// A theme added to the registry (and its colors), with nothing added to the settings UI.
beforeAll(() => {
  registry.push(fake)
  colors['test-dusk'] = { ...themes.dark, credit: { author: 'Dusk Maker', license: 'ISC', url: 'https://example.com/dusk' } }
})
afterAll(() => {
  registry.splice(registry.indexOf(fake), 1)
  delete colors['test-dusk']
})

test('a theme added to the registry appears in its scheme group with a swatch, with no settings UI change', async () => {
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command: string) =>
    command === 'settings.get'
      ? { maxAgents: 3, whenClosed: 'tray', orchestratorWebAccess: true, theme: { choice: 'light', light: 'light', dark: 'dark' } }
      : { maxAgents: 3, whenClosed: 'tray', orchestratorWebAccess: true, theme: { choice: 'test-dusk', light: 'light', dark: 'dark' } }
  )
  renderWithMantine(<ThemeSettings opened />)
  const box = await screen.findByRole('combobox', { name: 'Theme' })
  await vi.waitFor(() => expect(box).toBeEnabled())
  await userEvent.click(box)
  const dark = within(await screen.findByRole('listbox')).getByRole('group', { name: 'Dark' })
  const option = within(dark).getByRole('option', { name: 'Test Dusk, dark' })
  expect(option.querySelector('[data-theme-swatch="test-dusk"]')).toHaveAttribute('aria-hidden', 'true')
})
