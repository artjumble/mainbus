import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ThemeChoice, ThemeId, ThemeScheme, ThemeSetting } from '../../../shared/domain'
import { invoke } from '../api'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { themes } from '../theme'
import { ThemeSettings } from './ThemeSettings'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))
vi.mock('../notify', () => ({ showError: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>

let storedTheme: ThemeSetting

beforeEach(() => {
  mockInvoke.mockReset()
  storedTheme = { choice: 'light', light: 'light', dark: 'dark' }
  const settings = () => ({ maxAgents: 3, whenClosed: 'tray', orchestratorWebAccess: true, theme: storedTheme })
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'settings.get') return settings()
    if (command === 'settings.setTheme') {
      storedTheme = { ...storedTheme, choice: args[0] as ThemeChoice }
      return settings()
    }
    if (command === 'settings.setMatchWindowsTheme') {
      storedTheme = { ...storedTheme, [args[0] as ThemeScheme]: args[1] as ThemeId }
      return settings()
    }
    return undefined
  })
})

const rgb = (hex: string): string => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`

test('does not load anything while the settings are closed', () => {
  renderWithMantine(<ThemeSettings opened={false} />)
  expect(mockInvoke).not.toHaveBeenCalled()
})

test('the theme is Light by default, and offers every theme and Match Windows', async () => {
  renderWithMantine(<ThemeSettings opened />)
  const group = await screen.findByRole('radiogroup', { name: 'Theme' })
  const light = within(group).getByRole('radio', { name: 'Light' })
  await vi.waitFor(() => expect(light).toBeChecked())
  expect(within(group).getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual(['light', 'dark', 'night-owl', 'light-owl', 'system'])
  // Each radio is named by its theme alone: the preview adds nothing to the name.
  for (const name of ['Light', 'Dark', 'Night Owl', 'Light Owl', 'Match Windows']) expect(within(group).getByRole('radio', { name })).toBeInTheDocument()

  await userEvent.click(within(group).getByRole('radio', { name: 'Dark' }))
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setTheme', 'dark'))
  expect(storedTheme.choice).toBe('dark')
  expect(within(group).getByRole('radio', { name: 'Dark' })).toBeChecked()

  await userEvent.click(within(group).getByRole('radio', { name: 'Night Owl' }))
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setTheme', 'night-owl'))
  expect(within(group).getByRole('radio', { name: 'Night Owl' })).toBeChecked()

  await userEvent.click(within(group).getByRole('radio', { name: 'Match Windows' }))
  await vi.waitFor(() => expect(storedTheme.choice).toBe('system'))
  expect(within(group).getByRole('radio', { name: 'Match Windows' })).toBeChecked()
})

test('each theme shows a preview in its own colours, hidden from assistive technology', async () => {
  renderWithMantine(<ThemeSettings opened />)
  const group = await screen.findByRole('radiogroup', { name: 'Theme' })
  const swatches = [...group.querySelectorAll<HTMLElement>('[data-theme-swatch]')]
  expect(swatches.map((s) => s.dataset['themeSwatch'])).toEqual(['light', 'dark', 'night-owl', 'light-owl'])
  for (const s of swatches) {
    expect(s).toHaveAttribute('aria-hidden', 'true')
    expect(s.children).toHaveLength(5)
  }
  // Night Owl's: ground, surface, text, Working and Needs you.
  const nightOwl = swatches[2]!
  const fills = [...nightOwl.children].map((c) => getComputedStyle(c).backgroundColor)
  expect(fills).toEqual([themes['night-owl'].palette.ground, themes['night-owl'].palette.surface, themes['night-owl'].palette.text, themes['night-owl'].colors.working[6], themes['night-owl'].colors.needs[6]].map(rgb))
})

test('Match Windows offers a light and a dark theme, each from the themes of that scheme, Light and Dark by default', async () => {
  renderWithMantine(<ThemeSettings opened />)
  await screen.findByRole('radiogroup', { name: 'Theme' })
  await vi.waitFor(() => expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked())
  expect(screen.queryByRole('radiogroup', { name: 'Light theme' })).not.toBeInTheDocument()
  expect(screen.queryByRole('radiogroup', { name: 'Dark theme' })).not.toBeInTheDocument()

  await userEvent.click(screen.getByRole('radio', { name: 'Match Windows' }))
  const lightGroup = await screen.findByRole('radiogroup', { name: 'Light theme' })
  const darkGroup = screen.getByRole('radiogroup', { name: 'Dark theme' })
  expect(within(lightGroup).getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual(['light', 'light-owl'])
  expect(within(darkGroup).getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual(['dark', 'night-owl'])
  expect(within(lightGroup).getByRole('radio', { name: 'Light' })).toBeChecked()
  expect(within(darkGroup).getByRole('radio', { name: 'Dark' })).toBeChecked()
  expect(lightGroup.querySelectorAll('[data-theme-swatch]')).toHaveLength(2)

  await userEvent.click(within(darkGroup).getByRole('radio', { name: 'Night Owl' }))
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setMatchWindowsTheme', 'dark', 'night-owl'))
  expect(storedTheme).toEqual({ choice: 'system', light: 'light', dark: 'night-owl' })
  expect(within(darkGroup).getByRole('radio', { name: 'Night Owl' })).toBeChecked()

  await userEvent.click(within(lightGroup).getByRole('radio', { name: 'Light Owl' }))
  await vi.waitFor(() => expect(storedTheme.light).toBe('light-owl'))
  await expectNoAxeViolations()

  // Picking a theme outright puts the follow-up choices away.
  await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Theme' })).getByRole('radio', { name: 'Dark' }))
  await vi.waitFor(() => expect(screen.queryByRole('radiogroup', { name: 'Dark theme' })).not.toBeInTheDocument())
})

test('a Match Windows theme that cannot be saved goes back to the one before', async () => {
  storedTheme = { choice: 'system', light: 'light', dark: 'dark' }
  renderWithMantine(<ThemeSettings opened />)
  const darkGroup = await screen.findByRole('radiogroup', { name: 'Dark theme' })
  const dark = within(darkGroup).getByRole('radio', { name: 'Dark' })
  await vi.waitFor(() => expect(dark).toBeChecked())
  mockInvoke.mockImplementationOnce(async () => {
    throw new Error('disk full')
  })
  await userEvent.click(within(darkGroup).getByRole('radio', { name: 'Night Owl' }))
  await vi.waitFor(() => expect(dark).toBeChecked())
  expect(storedTheme.dark).toBe('dark')
})

test('shows the stored theme', async () => {
  storedTheme = { choice: 'system', light: 'light-owl', dark: 'night-owl' }
  renderWithMantine(<ThemeSettings opened />)
  await vi.waitFor(() => expect(screen.getByRole('radio', { name: 'Match Windows' })).toBeChecked())
  expect(within(screen.getByRole('radiogroup', { name: 'Light theme' })).getByRole('radio', { name: 'Light Owl' })).toBeChecked()
  expect(within(screen.getByRole('radiogroup', { name: 'Dark theme' })).getByRole('radio', { name: 'Night Owl' })).toBeChecked()
})

test('credits Night Owl and Light Owl', async () => {
  renderWithMantine(<ThemeSettings opened />)
  expect(await screen.findByText(/Night Owl and Light Owl theme colours by Sarah Drasner \(MIT\)/)).toBeInTheDocument()
})

test('a theme that cannot be saved goes back to the one before', async () => {
  renderWithMantine(<ThemeSettings opened />)
  const light = await screen.findByRole('radio', { name: 'Light' })
  await vi.waitFor(() => expect(light).toBeChecked())
  mockInvoke.mockImplementationOnce(async () => {
    throw new Error('disk full')
  })
  await userEvent.click(screen.getByRole('radio', { name: 'Dark' }))
  await vi.waitFor(() => expect(light).toBeChecked())
  expect(storedTheme.choice).toBe('light')
})
