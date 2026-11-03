import { DEFAULT_THEME, mergeMantineTheme } from '@mantine/core'
import { contrastRatio } from './contrast'
import { cssVariablesResolver, palette, theme } from './theme'

const merged = mergeMantineTheme(DEFAULT_THEME, theme)
const light = cssVariablesResolver(merged).light
const shade = (name: string, i: number): string => merged.colors[name][i]

test('theme carries the wireframe palette', () => {
  expect(theme.colors?.needs?.[6]).toBe('#B5530F') // Needs you orange
  expect(theme.colors?.working?.[6]).toBe('#1E3F99') // Working blue
  expect(theme.fontFamily).toContain('Segoe UI')
})

test('transitions honour reduced motion', () => {
  expect(theme.respectReducedMotion).toBe(true)
})

/** The colour a `var(--mantine-color-x-n)` token or a literal resolves to. */
function resolve(value: string): string {
  const named = /^var\(--mantine-color-([a-z]+)-(\d)\)$/.exec(value)
  return named ? shade(named[1], Number(named[2])) : value
}

const ground = palette.ground
const white = '#ffffff'
const dimmed = shade('gray', 6)
const placeholder = resolve(light['--mantine-color-placeholder'])

// Mantine 9's light variant: shade 1 behind shade 9 text; outline: the filled shade as text and border.
const tints = ['gray', 'needs', 'working', 'red', 'yellow']

describe('text meets 4.5:1', () => {
  const pairs: [string, string, string][] = [
    ['text on ground', palette.text, ground],
    ['text on white', palette.text, white],
    ['dimmed on ground', dimmed, ground],
    ['dimmed on white', dimmed, white],
    ['dimmed on the working tint', dimmed, shade('working', 0)],
    ['dimmed on the needs tint', dimmed, shade('needs', 0)],
    ['placeholder on white', placeholder, white],
    ['anchor on ground', shade('working', 6), ground],
    ['anchor on white', shade('working', 6), white],
    ['needs text on ground', shade('needs', 7), ground],
    ['needs text on white', shade('needs', 7), white],
    ['error red on ground', shade('red', 6), ground],
    ['white on a filled working button', white, shade('working', 6)],
    ['white on a filled needs button', white, shade('needs', 6)],
    ['white on a filled red button', white, shade('red', 6)],
    ['white on a filled gray button', white, shade('gray', 6)],
    ['white on a hovered filled red button', white, shade('red', 7)],
    ['white on a hovered filled working button', white, shade('working', 7)],
    ...tints.flatMap((c): [string, string, string][] => [
      [`${c} light chip`, shade(c, 9), shade(c, 1)],
      [`${c} light chip on hover`, shade(c, 9), shade(c, 2)],
      [`${c} outline chip on ground`, shade(c, 6), ground],
      [`${c} outline chip on white`, shade(c, 6), white]
    ]).filter(([n]) => !n.startsWith('yellow outline'))
  ]
  test.each(pairs)('%s', (_name, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('large text and meaningful marks meet 3:1', () => {
  test.each([
    ['the focus ring on the ground', shade('working', 5), ground],
    ['the focus ring on white', shade('working', 5), white],
    ['the working dot on the ground', shade('working', 5), ground]
  ])('%s', (_name, fg, bg) => {
    expect(contrastRatio(fg as string, bg as string)).toBeGreaterThanOrEqual(3)
  })
})
