import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { THEMES, type ThemeChoice, type ThemeId, type ThemeScheme, type ThemeSetting } from '../../../shared/domain'
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

const names = (scheme: ThemeScheme): string[] => THEMES.filter((t) => t.scheme === scheme).map((t) => t.name)

async function openList(name: string): Promise<HTMLElement> {
  const box = await screen.findByRole('combobox', { name })
  await vi.waitFor(() => expect(box).toBeEnabled())
  await userEvent.click(box)
  return await screen.findByRole('listbox')
}

test('does not load anything while the settings are closed', () => {
  renderWithMantine(<ThemeSettings opened={false} />)
  expect(mockInvoke).not.toHaveBeenCalled()
})

test('the theme is Light by default, with a Single theme / Match Windows switch', async () => {
  renderWithMantine(<ThemeSettings opened />)
  const mode = await screen.findByRole('radiogroup', { name: 'Theme' })
  await vi.waitFor(() => expect(within(mode).getByRole('radio', { name: 'Single theme' })).toBeChecked())
  expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveValue('Light')
  expect(screen.queryByRole('combobox', { name: 'When Windows is light' })).not.toBeInTheDocument()

  await userEvent.click(within(mode).getByRole('radio', { name: 'Match Windows' }))
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setTheme', 'system'))
  expect(await screen.findByRole('combobox', { name: 'When Windows is light' })).toHaveValue('Light')
  expect(screen.getByRole('combobox', { name: 'When Windows is dark' })).toHaveValue('Dark')
  expect(screen.queryByRole('combobox', { name: 'Theme' })).not.toBeInTheDocument()

  // Windows is light in the test, so Single theme keeps the light theme in use.
  storedTheme.light = 'light-owl'
  await userEvent.click(within(mode).getByRole('radio', { name: 'Single theme' }))
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setTheme', 'light-owl'))
  expect(await screen.findByRole('combobox', { name: 'Theme' })).toHaveValue('Light Owl')
})

test('the picker lists every theme, grouped Light and Dark, each with a hidden swatch', async () => {
  renderWithMantine(<ThemeSettings opened />)
  const list = await openList('Theme')
  const light = within(list).getByRole('group', { name: 'Light' })
  const dark = within(list).getByRole('group', { name: 'Dark' })
  expect(within(light).getAllByRole('option').map((o) => o.textContent?.replace(/, light$/, ''))).toEqual(names('light'))
  expect(within(dark).getAllByRole('option').map((o) => o.textContent?.replace(/, dark$/, ''))).toEqual(names('dark'))
  expect(within(list).getByRole('option', { name: 'Night Owl, dark' })).toBeInTheDocument()
  const swatches = [...list.querySelectorAll<HTMLElement>('[data-theme-swatch]')]
  expect(swatches.map((s) => s.dataset['themeSwatch']).sort()).toEqual(THEMES.map((t) => t.id).sort())
  for (const s of swatches) {
    expect(s).toHaveAttribute('aria-hidden', 'true')
    expect(s.children).toHaveLength(5)
  }
  const nightOwl = list.querySelector<HTMLElement>('[data-theme-swatch="night-owl"]')!
  const fills = [...nightOwl.children].map((c) => getComputedStyle(c).backgroundColor)
  const t = themes['night-owl']
  expect(fills).toEqual([t.palette.ground, t.palette.surface, t.palette.text, t.colors.working[6], t.colors.needs[6]].map(rgb))
  await expectNoAxeViolations()
})

test('typing filters the themes by name', async () => {
  renderWithMantine(<ThemeSettings opened />)
  await openList('Theme')
  const box = screen.getByRole('combobox', { name: 'Theme' })
  await userEvent.clear(box)
  await userEvent.keyboard('owl')
  expect(screen.getAllByRole('option')).toHaveLength(2)
  await userEvent.clear(box)
  await userEvent.keyboard('zzz')
  expect(await screen.findByText('No theme matches')).toBeInTheDocument()
})

test('choosing a theme saves it, and shows its credit', async () => {
  renderWithMantine(<ThemeSettings opened />)
  await openList('Theme')
  expect(screen.queryByText(/Sarah Drasner/)).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('option', { name: 'Night Owl, dark' }))
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setTheme', 'night-owl'))
  expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveValue('Night Owl')
  expect(await screen.findByText(/Sarah Drasner \(MIT\)/)).toBeInTheDocument()
})

test('the keyboard picks a theme: type, arrow, Enter', async () => {
  renderWithMantine(<ThemeSettings opened />)
  await openList('Theme')
  await userEvent.clear(screen.getByRole('combobox', { name: 'Theme' }))
  await userEvent.keyboard('night{ArrowDown}{Enter}')
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setTheme', 'night-owl'))
})

test('Escape closes the list without saving', async () => {
  renderWithMantine(<ThemeSettings opened />)
  await openList('Theme')
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  expect(mockInvoke).not.toHaveBeenCalledWith('settings.setTheme', expect.anything())
})

test('the Match Windows pickers each offer their own scheme and save per scheme', async () => {
  storedTheme = { choice: 'system', light: 'light', dark: 'dark' }
  renderWithMantine(<ThemeSettings opened />)
  const lightList = await openList('When Windows is light')
  expect(within(lightList).getAllByRole('option')).toHaveLength(names('light').length)
  expect(within(lightList).queryByRole('group', { name: 'Dark' })).not.toBeInTheDocument()
  await userEvent.click(within(lightList).getByRole('option', { name: 'Light Owl, light' }))
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setMatchWindowsTheme', 'light', 'light-owl'))

  const darkList = await openList('When Windows is dark')
  expect(within(darkList).getAllByRole('option')).toHaveLength(names('dark').length)
  await userEvent.click(within(darkList).getByRole('option', { name: 'Night Owl, dark' }))
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('settings.setMatchWindowsTheme', 'dark', 'night-owl'))
  expect(storedTheme).toEqual({ choice: 'system', light: 'light-owl', dark: 'night-owl' })
  expect(await screen.findAllByText(/Sarah Drasner \(MIT\)/)).toHaveLength(2)
})

test('a Match Windows theme that cannot be saved goes back to the one before', async () => {
  storedTheme = { choice: 'system', light: 'light', dark: 'dark' }
  renderWithMantine(<ThemeSettings opened />)
  const box = await screen.findByRole('combobox', { name: 'When Windows is dark' })
  await vi.waitFor(() => expect(box).toHaveValue('Dark'))
  const list = await openList('When Windows is dark')
  mockInvoke.mockImplementationOnce(async () => {
    throw new Error('disk full')
  })
  await userEvent.click(within(list).getByRole('option', { name: 'Night Owl, dark' }))
  await vi.waitFor(() => expect(box).toHaveValue('Dark'))
  expect(storedTheme.dark).toBe('dark')
})

test('shows the stored theme', async () => {
  storedTheme = { choice: 'system', light: 'light-owl', dark: 'night-owl' }
  renderWithMantine(<ThemeSettings opened />)
  await vi.waitFor(() => expect(screen.getByRole('radio', { name: 'Match Windows' })).toBeChecked())
  expect(screen.getByRole('combobox', { name: 'When Windows is light' })).toHaveValue('Light Owl')
  expect(screen.getByRole('combobox', { name: 'When Windows is dark' })).toHaveValue('Night Owl')
})

test('a theme that cannot be saved goes back to the one before', async () => {
  renderWithMantine(<ThemeSettings opened />)
  const box = await screen.findByRole('combobox', { name: 'Theme' })
  await vi.waitFor(() => expect(box).toHaveValue('Light'))
  const list = await openList('Theme')
  mockInvoke.mockImplementationOnce(async () => {
    throw new Error('disk full')
  })
  await userEvent.click(within(list).getByRole('option', { name: 'Dark, dark' }))
  await vi.waitFor(() => expect(box).toHaveValue('Light'))
  expect(storedTheme.choice).toBe('light')
})
