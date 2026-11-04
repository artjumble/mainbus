import { act, render, screen } from '@testing-library/react'
import type { EngineEvent } from '../../shared/api'
import { onEngineEvent } from './api'
import { colorSchemeOf, ThemedProvider } from './ThemedProvider'

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

test.each([
  ['light', false, 'light'],
  ['light', true, 'light'],
  ['dark', false, 'dark'],
  ['dark', true, 'dark'],
  ['system', false, 'light'],
  ['system', true, 'dark']
] as const)('%s with Windows dark %s draws %s', (choice, systemDark, expected) => {
  expect(colorSchemeOf(choice, systemDark)).toBe(expected)
})

test('starts in the stored scheme', () => {
  render(<ThemedProvider initial="dark" env="test"><p>board</p></ThemedProvider>)
  expect(screen.getByText('board')).toBeInTheDocument()
  expect(scheme()).toBe('dark')
})

test('a change to the setting applies at once, and back again', () => {
  render(<ThemedProvider initial="light" env="test"><p>board</p></ThemedProvider>)
  expect(scheme()).toBe('light')
  act(() => emit({ type: 'theme.changed', theme: 'dark' }))
  expect(scheme()).toBe('dark')
  act(() => emit({ type: 'theme.changed', theme: 'light' }))
  expect(scheme()).toBe('light')
})

test('Match Windows follows a change to the Windows setting while the app runs', () => {
  render(<ThemedProvider initial="system" env="test"><p>board</p></ThemedProvider>)
  expect(scheme()).toBe('light')
  setWindowsDark(true)
  expect(scheme()).toBe('dark')
  setWindowsDark(false)
  expect(scheme()).toBe('light')
})

test('Light and Dark ignore the Windows setting', () => {
  render(<ThemedProvider initial="light" env="test"><p>board</p></ThemedProvider>)
  setWindowsDark(true)
  expect(scheme()).toBe('light')
  act(() => emit({ type: 'theme.changed', theme: 'dark' }))
  setWindowsDark(false)
  expect(scheme()).toBe('dark')
})
