import { DEFAULT_THEME, defaultCssVariablesResolver, mergeMantineTheme } from '@mantine/core'
import { GROUND } from '../../shared/domain'
import { contrastRatio } from './contrast'
import { cssVariablesResolver, palettes, schemeColors, theme } from './theme'

const merged = mergeMantineTheme(DEFAULT_THEME, theme)

type Scheme = 'light' | 'dark'

/** Every CSS variable a scheme ends up with, as Mantine merges them, each `var(...)` followed to the value it resolves to. */
function resolvedVariables(scheme: Scheme): Record<string, string> {
  const custom = cssVariablesResolver(merged)
  const base = defaultCssVariablesResolver(merged)
  const all: Record<string, string> = { ...base.variables, ...custom.variables, ...base[scheme], ...custom[scheme] }
  const follow = (v: string, depth = 0): string =>
    depth > 10 ? v : v.replace(/var\((--[\w-]+)\)/g, (m, name: string) => (name in all ? follow(all[name], depth + 1) : m))
  return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, follow(v)]))
}

test('theme carries the wireframe palette', () => {
  expect(schemeColors.needs.light[6]).toBe('#B5530F') // Needs you orange
  expect(schemeColors.working.light[6]).toBe('#1E3F99') // Working blue
  expect(theme.fontFamily).toContain('Segoe UI')
})

test('light looks exactly as it did before the dark scheme', () => {
  // The snapshot was taken before the dark scheme was added; variables added since (the light and dark tuples behind
  // each virtual colour, their contrast colours, Mainbus's own) are not in it.
  const now = resolvedVariables('light')
  const before = Object.keys(now)
    .filter((k) => !/^--mantine-color-[a-z]+((Light|Dark)-|-contrast$)|^--mainbus-/.test(k))
    .sort()
  expect(Object.fromEntries(before.map((k) => [k, now[k]]))).toMatchSnapshot()
  // The one new light variable keeps the colour it replaced.
  expect(now['--mainbus-color-strong-border']).toBe(now['--mantine-color-dark-6'])
})

test('each scheme paints the ground the window is painted with before the page loads', () => {
  expect(resolvedVariables('light')['--mantine-color-body']).toBe(GROUND.light)
  expect(resolvedVariables('dark')['--mantine-color-body']).toBe(GROUND.dark)
  expect(palettes.dark.ground).toBe(GROUND.dark)
})

test('the dark Needs you orange and Working blue are still orange and blue', () => {
  const hue = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    const max = Math.max(r, g, b)
    const d = max - Math.min(r, g, b)
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    return (h * 60 + 360) % 360
  }
  for (const name of ['needs', 'working'] as const) {
    for (const i of [5, 6, 7]) {
      expect(Math.abs(hue(schemeColors[name].dark[i]) - hue(schemeColors[name].light[6]))).toBeLessThan(12)
    }
  }
})

test('transitions honour reduced motion', () => {
  expect(theme.respectReducedMotion).toBe(true)
})

const white = '#ffffff'
// Mantine's light variant (a chip, an alert): its background and hover behind its text; outline: one colour as text and border.
const tints = ['gray', 'needs', 'working', 'red', 'yellow']

describe.each(['light', 'dark'] as const)('%s', (scheme) => {
  const vars = resolvedVariables(scheme)
  const color = (name: string): string => {
    const value = vars[`--mantine-color-${name}`]
    if (value === undefined) throw new Error(`No --mantine-color-${name} in ${scheme}`)
    return value
  }
  const ground = color('body')
  // Inputs, default buttons and Mantine's cards: white in light.
  const surface = color('default')
  const text = color('text')
  const dimmed = color('dimmed')

  test('the scheme uses its own palette', () => {
    expect(ground).toBe(palettes[scheme].ground)
    expect(text).toBe(palettes[scheme].text)
    expect(dimmed).toBe(palettes[scheme].dimmed)
    expect(color('default-border')).toBe(palettes[scheme].border)
    expect(scheme === 'light' ? surface : surface.toLowerCase()).toBe(scheme === 'light' ? '#fff' : palettes.dark.surface.toLowerCase())
  })

  describe('text meets 4.5:1', () => {
    const pairs: [string, string, string][] = [
      ['text on ground', text, ground],
      ['text on a surface', text, surface],
      ['text on a hovered or selected row', text, color('default-hover')],
      ['dimmed on ground', dimmed, ground],
      ['dimmed on a surface', dimmed, surface],
      ['dimmed on a hovered or selected row', dimmed, color('default-hover')],
      ['dimmed on the working tint (a drop target)', dimmed, color('working-0')],
      ['dimmed on the needs tint (the Needs you column, a permission card)', dimmed, color('needs-0')],
      ['text on the needs tint', text, color('needs-0')],
      ['placeholder on a surface', color('placeholder'), surface],
      ['anchor on ground', color('anchor'), ground],
      ['anchor on a surface', color('anchor'), surface],
      ['needs text on ground', color('needs-7'), ground],
      ['needs text on a surface', color('needs-7'), surface],
      ['needs text on the needs tint', color('needs-7'), color('needs-0')],
      ['a handoff divider on ground', color('working-text'), ground],
      ['error text on ground', color('error'), ground],
      ['error text on a surface', color('error'), surface],
      ['white on a dark button', white, color('dark-filled')],
      ['white on a hovered dark button', white, color('dark-filled-hover')],
      ...tints.flatMap((c): [string, string, string][] => [
        [`white on a filled ${c} button`, white, color(`${c}-filled`)],
        [`white on a hovered filled ${c} button`, white, color(`${c}-filled-hover`)],
        [`${c} light chip or alert`, color(`${c}-light-color`), color(`${c}-light`)],
        [`${c} light chip on hover`, color(`${c}-light-color`), color(`${c}-light-hover`)],
        [`dimmed in a ${c} alert`, dimmed, color(`${c}-light`)],
        [`${c} outline chip on ground`, color(`${c}-outline`), ground],
        [`${c} outline chip on a surface`, color(`${c}-outline`), surface],
        [`${c} subtle button on ground`, color(`${c}-light-color`), ground],
        [`${c} subtle button on hover`, color(`${c}-light-color`), color(`${c}-light-hover`)]
      ])
        // The app has no yellow outline chips, subtle buttons or filled buttons.
        .filter(([n]) => !/^yellow (outline|subtle)|yellow button/.test(n))
    ]
    test.each(pairs)('%s', (_name, fg, bg) => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5)
    })
  })

  describe('large text and meaningful marks meet 3:1', () => {
    test.each([
      ['the focus ring (the primary fill) on the ground', vars['--mantine-primary-color-filled'], ground],
      ['the focus ring on a surface', vars['--mantine-primary-color-filled'], surface],
      ['the recently-changed outline on the ground', color('working-5'), ground],
      ['the working dot on the ground', color('working-filled'), ground],
      ['the border of a card that needs you', color('needs-6'), ground],
      ['the dashed border of a failed card', vars['--mainbus-color-strong-border'], ground],
      ['the border of the active role in the lineup strip', color('working-6'), color('working-light')]
    ])('%s', (_name, fg, bg) => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(3)
    })
  })
})
