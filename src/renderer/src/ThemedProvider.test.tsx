import { act, render, screen } from '@testing-library/react'
import type { EngineEvent } from '../../shared/api'
import { GROUND, THEME_SETTING_DEFAULT, type ThemeChoice, type ThemeSetting } from '../../shared/domain'
import { onEngineEvent } from './api'
import { ThemedProvider } from './ThemedProvider'

vi.mock('./api', () => ({ onEngineEvent: vi.fn() }))

let emit: (e: EngineEvent) => void = () => {}

/** A prefers-color-scheme query whose answer the test changes, as Windows would. */
let windowsDark = false
const mediaListeners = new Set<(e: { matches: boolean }) => void>()
const realMatchMedia = window.matchMedia

beforeEach(() => {
  windowsDark = false
  mediaListeners.clear()
  vi.mocked(onEngineEvent).mockImplementation((l) => {
    emit = l
    return () => {
      emit = () => {}
    }
  })
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === '(prefers-color-scheme: dark)' && windowsDark
    },
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_: string, l: (e: { matches: boolean }) => void) => mediaListeners.add(l),
    removeEventListener: (_: string, l: (e: { matches: boolean }) => void) => mediaListeners.delete(l),
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
})

afterEach(() => {
  window.matchMedia = realMatchMedia
})

function setWindowsDark(dark: boolean): void {
  windowsDark = dark
  act(() => mediaListeners.forEach((l) => l({ matches: dark })))
}

const scheme = (): string | null => document.documentElement.getAttribute('data-mantine-color-scheme')
const themeId = (): string | undefined => document.documentElement.dataset['mainbusTheme']
/** The CSS Mantine injected for the theme in use. */
const injectedCss = (): string => [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n')

const choose = (choice: ThemeChoice, picks: Partial<ThemeSetting> = {}): ThemeSetting => ({ ...THEME_SETTING_DEFAULT, ...picks, choice })

test('starts in the stored theme', () => {
  render(<ThemedProvider initial={choose('dark')} env="test"><p>board</p></ThemedProvider>)
  expect(screen.getByText('board')).toBeInTheDocument()
  expect(scheme()).toBe('dark')
  expect(themeId()).toBe('dark')
})

test('a change to the setting applies at once, and back again', () => {
  render(<ThemedProvider initial={choose('light')} env="test"><p>board</p></ThemedProvider>)
  expect(scheme()).toBe('light')
  act(() => emit({ type: 'theme.changed', theme: choose('dark') }))
  expect(scheme()).toBe('dark')
  act(() => emit({ type: 'theme.changed', theme: choose('light') }))
  expect(scheme()).toBe('light')
  expect(themeId()).toBe('light')
})

test('Night Owl applies at once: a dark scheme, painted in its own ground', () => {
  render(<ThemedProvider initial={choose('light')} env="test"><p>board</p></ThemedProvider>)
  act(() => emit({ type: 'theme.changed', theme: choose('night-owl') }))
  expect(themeId()).toBe('night-owl')
  expect(scheme()).toBe('dark')
  expect(injectedCss()).toContain(`--mantine-color-body: ${GROUND['night-owl']}`)
  act(() => emit({ type: 'theme.changed', theme: choose('light-owl') }))
  expect(themeId()).toBe('light-owl')
  expect(scheme()).toBe('light')
  expect(injectedCss()).toContain(`--mantine-color-body: ${GROUND['light-owl']}`)
})

test('Match Windows follows a change to the Windows setting while the app runs', () => {
  render(<ThemedProvider initial={choose('system')} env="test"><p>board</p></ThemedProvider>)
  expect(scheme()).toBe('light')
  setWindowsDark(true)
  expect(scheme()).toBe('dark')
  expect(themeId()).toBe('dark')
  setWindowsDark(false)
  expect(scheme()).toBe('light')
})

test('Match Windows uses the light and dark themes picked for it', () => {
  render(<ThemedProvider initial={choose('system', { dark: 'night-owl' })} env="test"><p>board</p></ThemedProvider>)
  expect(themeId()).toBe('light')
  setWindowsDark(true)
  expect(themeId()).toBe('night-owl')
  act(() => emit({ type: 'theme.changed', theme: choose('system', { light: 'light-owl', dark: 'night-owl' }) }))
  setWindowsDark(false)
  expect(themeId()).toBe('light-owl')
  expect(scheme()).toBe('light')
})

test('a theme chosen outright ignores the Windows setting', () => {
  render(<ThemedProvider initial={choose('light')} env="test"><p>board</p></ThemedProvider>)
  setWindowsDark(true)
  expect(scheme()).toBe('light')
  act(() => emit({ type: 'theme.changed', theme: choose('dark') }))
  setWindowsDark(false)
  expect(scheme()).toBe('dark')
  act(() => emit({ type: 'theme.changed', theme: choose('night-owl') }))
  setWindowsDark(true)
  setWindowsDark(false)
  expect(themeId()).toBe('night-owl')
})
