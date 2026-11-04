import { DEFAULT_THEME, defaultCssVariablesResolver, mergeMantineTheme } from '@mantine/core'
import { GROUND, THEME_IDS, THEMES, themeOf, type ThemeId } from '../../shared/domain'
import { contrastRatio } from './contrast'
import { mantineThemes, NAMED_COLORS, themes } from './theme'

/** Every CSS variable a theme ends up with, as Mantine merges them, each `var(...)` followed to the value it resolves to. */
function resolvedVariables(id: ThemeId): Record<string, string> {
  const { scheme, theme, cssVariablesResolver } = mantineThemes[id]
  const merged = mergeMantineTheme(DEFAULT_THEME, theme)
  const custom = cssVariablesResolver(merged)
  const base = defaultCssVariablesResolver(merged)
  const all: Record<string, string> = { ...base.variables, ...custom.variables, ...base[scheme], ...custom[scheme] }
  const follow = (v: string, depth = 0): string =>
    depth > 10 ? v : v.replace(/var\((--[\w-]+)\)/g, (m, name: string) => (name in all ? follow(all[name], depth + 1) : m))
  return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, follow(v)]))
}

const hue = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}
const hueDistance = (a: string, b: string): number => {
  const d = Math.abs(hue(a) - hue(b))
  return Math.min(d, 360 - d)
}

test('theme carries the wireframe palette', () => {
  expect(themes.light.colors.needs[6]).toBe('#B5530F') // Needs you orange
  expect(themes.light.colors.working[6]).toBe('#1E3F99') // Working blue
  expect(mantineThemes.light.theme.fontFamily).toContain('Segoe UI')
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

test.each(['light', 'dark'] as const)('%s looks exactly as it did before the theme registry', (id) => {
  // The snapshot was taken before named themes were added; the light and dark tuples behind each virtual colour are not in it.
  const now = resolvedVariables(id)
  const before = Object.keys(now)
    .filter((k) => !/^--mantine-color-[a-z]+(Light|Dark)-/.test(k))
    .sort()
  expect(Object.fromEntries(before.map((k) => [k, now[k]]))).toMatchSnapshot()
})

test('the registry has every theme of THEMES, and nothing else', () => {
  expect(Object.keys(themes).sort()).toEqual([...THEME_IDS].sort())
  expect(Object.keys(mantineThemes).sort()).toEqual([...THEME_IDS].sort())
  expect(Object.keys(GROUND).sort()).toEqual([...THEME_IDS].sort())
  expect(new Set(THEMES.map((t) => t.name)).size).toBe(THEMES.length)
})

test('transitions honour reduced motion', () => {
  for (const id of THEME_IDS) expect(mantineThemes[id].theme.respectReducedMotion).toBe(true)
})

const white = '#ffffff'
const HEX = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/
// Mantine's light variant (a chip, an alert): its background and hover behind its text; outline: one colour as text and border.
// Green is in every theme for Mantine's own uses, but nothing in the app draws it, so it has no pairs here.
const tints = ['gray', 'needs', 'working', 'red', 'yellow']

describe.each(THEME_IDS)('%s', (id) => {
  const def = themes[id]
  const { scheme } = themeOf(id)
  const vars = resolvedVariables(id)
  const color = (name: string): string => {
    const value = vars[`--mantine-color-${name}`]
    if (value === undefined) throw new Error(`No --mantine-color-${name} in ${id}`)
    return value
  }
  const ground = color('body')
  // Inputs, default buttons and Mantine's cards: white in Light.
  const surface = color('default')
  const raised = color('default-hover')
  const text = color('text')
  const dimmed = color('dimmed')

  test('has every token: the palette, ten shades of each named colour, and a neutral ramp in a dark theme', () => {
    for (const v of Object.values(def.palette)) expect(v).toMatch(HEX)
    expect(Object.keys(def.palette).sort()).toEqual(
      ['anchor', 'border', 'dimmed', 'error', 'ground', 'raised', 'strongBorder', 'surface', 'text'].sort()
    )
    expect(Object.keys(def.colors).sort()).toEqual([...NAMED_COLORS].sort())
    for (const name of NAMED_COLORS) {
      expect(def.colors[name]).toHaveLength(10)
      for (const shade of def.colors[name]) expect(shade).toMatch(HEX)
    }
    if (scheme === 'dark') {
      expect(def.neutral).toHaveLength(10)
      expect(def.neutral![7]).toBe(def.palette.ground)
    }
  })

  test('paints the ground the window is painted with before the page loads', () => {
    expect(ground).toBe(GROUND[id])
    expect(def.palette.ground).toBe(GROUND[id])
    expect(vars['--mantine-color-scheme']).toBe(scheme)
  })

  test('uses its own palette', () => {
    expect(text).toBe(def.palette.text)
    expect(dimmed).toBe(def.palette.dimmed)
    expect(surface).toBe(def.palette.surface)
    expect(raised).toBe(def.palette.raised)
    expect(color('default-border')).toBe(def.palette.border)
    expect(color('anchor')).toBe(def.palette.anchor)
    expect(color('error')).toBe(def.palette.error)
    expect(vars['--mainbus-color-strong-border']).toBe(def.palette.strongBorder)
  })

  test('the Needs you orange and Working blue stay orange and blue', () => {
    for (const name of ['needs', 'working'] as const) {
      for (const i of [5, 6, 7]) expect(hueDistance(def.colors[name][i], def.colors[name][6])).toBeLessThan(12)
      // And each theme's are the app's orange and blue.
      expect(hueDistance(def.colors[name][6], themes.light.colors[name][6])).toBeLessThan(25)
    }
  })

  test('each colour changed for contrast keeps the hue of its original', () => {
    for (const a of def.adjusted ?? []) {
      expect(a.adjusted, a.use).not.toBe(a.original)
      expect(hueDistance(a.adjusted, a.original), a.use).toBeLessThan(12)
    }
  })

  describe('text meets 4.5:1', () => {
    const pairs: [string, string, string][] = [
      ['text on ground', text, ground],
      ['text on a surface', text, surface],
      ['text on a hovered or selected row', text, raised],
      ['dimmed on ground', dimmed, ground],
      ['dimmed on a surface', dimmed, surface],
      ['dimmed on a hovered or selected row', dimmed, raised],
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
      // Code: Mantine's Code and a markdown code block take the text colour on their own ground; inline markdown code
      // is black on gray-0 in light, white on dark-5 in dark.
      ['code on a Code ground', text, scheme === 'light' ? color('gray-0') : color('dark-6')],
      ['code on a code block', text, scheme === 'light' ? color('gray-0') : color('dark-8')],
      ['inline code', scheme === 'light' ? color('black') : color('white'), scheme === 'light' ? color('gray-0') : color('dark-5')],
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
