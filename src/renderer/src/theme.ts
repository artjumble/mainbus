import {
  ActionIcon,
  alpha,
  Anchor,
  Button,
  CloseButton,
  DEFAULT_THEME,
  Drawer,
  getContrastColor,
  Input,
  Loader,
  Menu,
  Modal,
  Popover,
  Checkbox,
  Radio,
  Switch,
  Tabs,
  UnstyledButton,
  type CSSVariablesResolver,
  type MantineColorsTuple,
  type MantineThemeOverride
} from '@mantine/core'
import { GROUND, THEMES, type ThemeId, type ThemeScheme } from '../../shared/domain'
import targets from './targets.module.css'

/*
 * Every colour of the app is here, one entry per theme in `themes` below; only each theme's ground is in shared code
 * (THEMES), for the main process. A theme gives each named colour one tuple, and the app's components name a colour
 * once (`needs.7`, `working-5`), whichever theme is in use.
 *
 * Each index has the same job in every theme: 0 a tinted ground (the Needs you column, a permission card), 1 and 2 a
 * chip and a hovered chip, 5 the focus ring and other marks, 6 a fill under white text and a meaningful border, 7 text
 * on the ground (and in light themes a hovered fill), 8 a hovered fill in dark themes, 9 a chip's text.
 */

/** The colours a theme names: the two app colours (Needs you and Working) and the ones Mantine's components use. */
export const NAMED_COLORS = ['needs', 'working', 'gray', 'red', 'yellow', 'green'] as const
export type NamedColor = (typeof NAMED_COLORS)[number]

/** A theme's wireframe palette. */
export interface Palette {
  /** The page ground. */
  ground: string
  /** Inputs, default buttons, cards, menus and dialogs. */
  surface: string
  /** A hovered or selected row, a hovered default button. */
  raised: string
  text: string
  /** Dimmed text, placeholders. */
  dimmed: string
  /** A board lane (column): a step away from the ground, so lanes read as fills and the cards on them stand out. */
  lane: string
  /** Default borders: panels, dividers, inputs. */
  border: string
  /** A board card's border: 3:1 on the lane, so a card's edge shows against it. */
  cardBorder: string
  /** A border that means something: the dashed border of a failed card. */
  strongBorder: string
  /** Links. */
  anchor: string
  /** Error text. */
  error: string
}

/** A colour of the theme's source that was made lighter or darker so its text and marks meet their contrast. */
export interface Adjusted {
  use: string
  original: string
  adjusted: string
}

export interface ThemeDef {
  palette: Palette
  colors: Record<NamedColor, MantineColorsTuple>
  /** Mantine's own neutral ramp (`dark-0` to `dark-9`), which its components use in the dark scheme. Dark themes only. */
  neutral?: MantineColorsTuple
  /** The colours taken from the theme's source and changed for contrast, each with its original. */
  adjusted?: readonly Adjusted[]
}

// ---------------------------------------------------------------------------------------------------------------------
// Light: the wireframe palette. Index 6 is the shade Mantine uses for filled variants.

const needsLight: MantineColorsTuple = [
  '#FFF3EA',
  '#FCE3CF',
  '#F7C9A3',
  '#EFAA73',
  '#E58B47',
  '#D26E24',
  '#B5530F', // Needs you orange
  '#9A4409',
  '#7F3706',
  '#652B04'
]

const workingLight: MantineColorsTuple = [
  '#EAF0FF',
  '#D3DEFA',
  '#A9BEF2',
  '#7E9BE6',
  '#5679D8',
  '#3A5FC4',
  '#1E3F99', // Working blue
  '#173280',
  '#112666',
  '#0B1A4D'
]

// Mantine's gray-6 (#868e96) is its dimmed text and outline colour, and is only 3:1 on the ground. Darker from 6 up.
const grayLight: MantineColorsTuple = [
  '#f8f9fa',
  '#f1f3f5',
  '#e9ecef',
  '#dee2e6',
  '#ced4da',
  '#adb5bd',
  '#5b6168',
  '#495057',
  '#343a40',
  '#212529'
]

// Mantine's red-6 (#fa5252) gives white text only 3.3:1; this one is its red-9, so a red button and error text pass.
const redLight: MantineColorsTuple = [
  '#fff5f5',
  '#ffe3e3',
  '#ffc9c9',
  '#ffa8a8',
  '#ff8787',
  '#ff6b6b',
  '#c92a2a',
  '#b02525',
  '#962020',
  '#7d1a1a'
]

// Mantine's yellow-9 (#e67700) is the text of a light yellow alert, and is only 2.7:1 on its tint.
const yellowLight: MantineColorsTuple = [
  '#fff9db',
  '#fff3bf',
  '#ffec99',
  '#ffe066',
  '#ffd43b',
  '#fcc419',
  '#fab005',
  '#f59f00',
  '#8a5a00',
  '#5c3d00'
]

const light: ThemeDef = {
  palette: {
    ground: GROUND.light,
    surface: '#fff',
    raised: grayLight[0],
    text: '#1F1F1F',
    dimmed: grayLight[6],
    lane: '#EAEAE5',
    border: '#CFCFCA',
    cardBorder: '#82827C',
    strongBorder: DEFAULT_THEME.colors.dark[6],
    anchor: workingLight[6],
    error: redLight[6]
  },
  // Nothing in the app draws green; Light and Dark keep Mantine's.
  colors: { needs: needsLight, working: workingLight, gray: grayLight, red: redLight, yellow: yellowLight, green: DEFAULT_THEME.colors.green }
}

// ---------------------------------------------------------------------------------------------------------------------
// Dark. Index 6 is the light hue, or close to it, so the orange and blue read as the same colours.

const needsDark: MantineColorsTuple = [
  '#2B1F16',
  '#3D2717',
  '#4C2F1A',
  '#5E3815',
  '#7F4718',
  '#E07B33',
  '#B5530F', // Needs you orange
  '#F0A061',
  '#9A4409',
  '#FBD3B0'
]

const workingDark: MantineColorsTuple = [
  '#1A2238',
  '#1F2B4D',
  '#26365E',
  '#2C3F70',
  '#3A55A0',
  '#7898F0',
  '#4370DB', // Working blue, lighter so it shows on the dark ground and still holds white text
  '#9FB7F7',
  '#2F52B0',
  '#D3DEFA'
]

const grayDark: MantineColorsTuple = [
  '#252523',
  '#2F2F2C',
  '#3A3A36',
  '#4A4A45',
  '#5C5C56',
  '#8E8E87',
  '#5E5E58',
  '#B9B9B2',
  '#4E4E49',
  '#E0E0DA'
]

const redDark: MantineColorsTuple = [
  '#2E1A1A',
  '#3F1F1F',
  '#4F2525',
  '#6A2A2A',
  '#8F3030',
  '#F07070',
  '#C92A2A',
  '#FF9C9C',
  '#A82424',
  '#FFD6D6'
]

const yellowDark: MantineColorsTuple = [
  '#29240F',
  '#372F10',
  '#463B14',
  '#5A4A14',
  '#7A6418',
  '#E8B923',
  '#8A5A00',
  '#F2CC5A',
  '#6E4800',
  '#FBE6A6'
]

/*
 * Mantine's neutral ramp as its components use it in the dark scheme: dark-0 text, dark-2 dimmed, dark-4 borders and a
 * dark button, dark-5 hover and inline code, dark-6 inputs, cards and code, dark-7 the body, dark-8 a code block.
 * Warm, like the light ground.
 */
const neutralDark: MantineColorsTuple = [
  '#E8E8E3',
  '#CFCFC9',
  '#ABABA4',
  '#8E8E87',
  '#4A4A45',
  '#3A3A36',
  '#2B2B28',
  GROUND.dark,
  '#191917',
  '#121211'
]

const dark: ThemeDef = {
  palette: {
    ground: neutralDark[7],
    surface: neutralDark[6],
    raised: neutralDark[5],
    text: neutralDark[0],
    dimmed: neutralDark[2],
    lane: '#252523',
    border: neutralDark[4],
    cardBorder: '#74746D',
    strongBorder: neutralDark[2],
    anchor: workingDark[7],
    error: redDark[7]
  },
  colors: { needs: needsDark, working: workingDark, gray: grayDark, red: redDark, yellow: yellowDark, green: DEFAULT_THEME.colors.green },
  neutral: neutralDark
}

// ---------------------------------------------------------------------------------------------------------------------
// Night Owl and Light Owl: theme colours by Sarah Drasner (MIT), from sdras/night-owl-vscode-theme. Each keeps its
// source's hues; where a colour of the source misses its contrast it is lighter (Night Owl) or darker (Light Owl), and
// is listed in `adjusted` with its original. The Owls' syntax colours are not used: nothing in the app is highlighted.

/*
 * Night Owl's colours that were changed (`adjusted` below):
 *   dimmed text   #5f7e97 → #8ca6bc (4.3:1 on the ground and 3.5:1 on a card; via Night Owl's own #89a4bb)
 *   error text    #EF5350 → #F26B68 (4.3:1 on a card)
 *   Working fill  #82AAFF → #246AFF (white on it is only 2.3:1)
 *   Needs fill    #F78C6C → #DA3B0C (white on it is only 2.4:1)
 *   red fill      #EF5350 → #D51713 (white on it is only 3.5:1)
 *   gray fill     #5f7e97 → #5B7890 (white on it is 4.3:1)
 */
const nightOwl: ThemeDef = {
  palette: {
    ground: GROUND['night-owl'], // editor.background
    surface: '#0B2942', // tab.activeBackground
    raised: '#1D3B53', // editor.selectionBackground
    text: '#D6DEEB', // editor.foreground
    dimmed: '#8CA6BC',
    lane: '#04203A',
    border: '#122D42', // focusBorder
    cardBorder: '#58789A',
    strongBorder: '#8CA6BC',
    anchor: '#82AAFF',
    error: '#F26B68'
  },
  colors: {
    working: ['#0E253D', '#122A44','#233C5F', '#2F4B75', '#426093', '#5C8EFF', '#246AFF', '#82AAFF', '#0F5BFF', '#C9D9FF'],
    needs: ['#1A222E', '#2D2B33', '#413539', '#5A4040', '#7C514A', '#F57A55', '#DA3B0C', '#F78C6C', '#C7360B', '#FDD3C4'],
    gray: ['#0F2436', '#1A3042', '#253B4E', '#334A5D', '#475E72', '#7790A6', '#5B7890', '#A9BCCC', '#4A6378', '#DDE6EE'],
    red: ['#191C2B', '#2C212E', '#3F2632', '#572C36', '#78353C', '#F05F5C', '#D51713', '#F26B68', '#BD1411', '#FFD0CF'],
    yellow: ['#192731', '#2B3539', '#3E4342', '#56554C', '#776D5A', '#ECC48D', '#8A6A2E', '#ECC48D', '#705622', '#F7E3C6'],
    green: ['#042A2E', '#073934', '#0A4939', '#0D5D41', '#12784B', '#1DBD63', '#11793D', '#22DA6E', '#0E6633', '#C3F5D6']
  },
  neutral: ['#D6DEEB', '#B6C4D4', '#8CA6BC', '#5F7E97', '#2A4D6B', '#1D3B53', '#0B2942', GROUND['night-owl'], '#01111F', '#000B14'],
  adjusted: [
    { use: 'dimmed text', original: '#5f7e97', adjusted: '#8CA6BC' },
    { use: 'error text', original: '#EF5350', adjusted: '#F26B68' },
    { use: 'Working fill under white text', original: '#82AAFF', adjusted: '#246AFF' },
    { use: 'Needs you fill under white text', original: '#F78C6C', adjusted: '#DA3B0C' },
    { use: 'red fill under white text', original: '#EF5350', adjusted: '#D51713' },
    { use: 'gray fill under white text', original: '#5f7e97', adjusted: '#5B7890' }
  ]
}

/*
 * Light Owl's colours that were changed (`adjusted` below). Light Owl has no orange, so its Needs you takes Night
 * Owl's #F78C6C, darkened for a light ground.
 *   dimmed text   #90A7B2 → #495F6A (2.2:1 on the ground; 5.3:1 on a hovered row, with room for Mantine's fades)
 *   Working       #4876D6 → #2D5EC7 (4.3:1 under white text, 3.8:1 on the ground)
 *   Needs you     #F78C6C → #B9320A (2.4:1 under white text)
 *   red           #DE3D3B → #C12321 (4.3:1 under white text, 3.5:1 on a hovered row)
 *   yellow text   #E0AF02 → #866901 (1.8:1 on its tint)
 *   gray fill     #90A7B2 → #495F6A (2.5:1 under white text)
 */
const lightOwl: ThemeDef = {
  palette: {
    ground: GROUND['light-owl'], // sideBar.background
    surface: '#FBFBFB', // editor.background
    raised: '#D3E8F8', // list.hoverBackground
    text: '#403F53', // editor.foreground
    dimmed: '#495F6A',
    lane: '#E6E6E6',
    border: '#D9D9D9', // input.border
    cardBorder: '#7E7E7E',
    strongBorder: '#435761',
    anchor: '#2D5EC7',
    error: '#C12321'
  },
  colors: {
    working: ['#EAF0FC', '#DCE5F8', '#C6D5F3', '#A3BBEC', '#7E9EE2', '#4876D6', '#2D5EC7', '#244FAB', '#1D418D', '#183670'],
    needs: ['#FEF3EE', '#FCE3D9', '#F9CDBB', '#F5AE93', '#F18E6B', '#E06A44', '#B9320A', '#9C2A08', '#7F2307', '#651B05'],
    gray: ['#F6F8F9', '#EDF1F3', '#E2E8EB', '#D3DCE0', '#BCCAD1', '#90A7B2', '#495F6A', '#435761', '#36464E', '#29363C'],
    red: ['#FCEFEF', '#FAE0E0', '#F6CDCC', '#F2B1B1', '#EB8B89', '#E56462', '#C12321', '#A51E1C', '#8A1918', '#701413'],
    yellow: ['#FDF9EB', '#FAF2D7', '#F7EABD', '#F3DF9A', '#ECCF67', '#E6BF35', '#E0AF02', '#DAAA01', '#866901', '#5A4601'],
    green: ['#EBF6F3', '#D7EDE7', '#BFE2D8', '#9CD3C3', '#6BBDA6', '#39A788', '#08916A', '#077A59', '#066349', '#044C38']
  },
  adjusted: [
    { use: 'dimmed text', original: '#90A7B2', adjusted: '#495F6A' },
    { use: 'Working', original: '#4876D6', adjusted: '#2D5EC7' },
    { use: 'Needs you (from Night Owl)', original: '#F78C6C', adjusted: '#B9320A' },
    { use: 'red', original: '#DE3D3B', adjusted: '#C12321' },
    { use: 'yellow text', original: '#E0AF02', adjusted: '#866901' },
    { use: 'gray fill under white text', original: '#90A7B2', adjusted: '#495F6A' }
  ]
}

/** Every theme's colours, by the id THEMES gives it: a theme in THEMES without an entry here does not compile. */
export const themes: Record<ThemeId, ThemeDef> = { light, dark, 'night-owl': nightOwl, 'light-owl': lightOwl }

// ---------------------------------------------------------------------------------------------------------------------

// Mantine's close buttons have no name of their own, and its dialog title bar is a <header>, which would be a
// second banner landmark next to the app's.
const dialog = { closeButtonProps: { 'aria-label': 'Close' }, attributes: { header: { role: 'presentation' } } }

function mantineTheme(def: ThemeDef, scheme: ThemeScheme): MantineThemeOverride {
  return {
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    headings: { fontFamily: 'inherit' },
    primaryColor: 'working',
    primaryShade: 6,
    // Mantine's black is light-scheme text (inline code, for one); dark themes keep Light's, as before themes.
    black: scheme === 'light' ? def.palette.text : light.palette.text,
    colors: def.colors,
    other: { palette: def.palette },
    // Transitions (menus, modals, collapses) and Mantine's own animations stop for people who ask for less motion.
    respectReducedMotion: true,
    components: {
      // Controls smaller than 44 px get a hit area of that size (see targets.module.css).
      Button: Button.extend({ classNames: { root: targets.target, inner: targets.loadingContent } }),
      ActionIcon: ActionIcon.extend({ classNames: { root: targets.target, icon: targets.loadingContent } }),
      CloseButton: CloseButton.extend({ classNames: { root: targets.target } }),
      UnstyledButton: UnstyledButton.extend({ classNames: { root: targets.target } }),
      Anchor: Anchor.extend({ classNames: { root: targets.target } }),
      Input: Input.extend({ classNames: { input: targets.field } }),
      Menu: Menu.extend({ classNames: { item: targets.menuItem } }),
      Loader: Loader.extend({ classNames: { root: targets.loader } }),
      Modal: Modal.extend({ defaultProps: dialog }),
      Tabs: Tabs.extend({ classNames: { tab: targets.tab } }),
      // A choice's label is what a click on it toggles, so the label itself is 44 px tall, and its rows 44 px apart, and the box is lined up with the label's first line.
      Checkbox: Checkbox.extend({ classNames: { root: targets.choice, label: targets.choiceLabel, inner: targets.checkboxBox } }),
      Radio: Radio.extend({ classNames: { root: targets.choice, label: targets.choiceLabel, inner: targets.radioBox } }),
      Switch: Switch.extend({ classNames: { root: targets.choice, label: targets.choiceLabel, track: targets.switchTrack } }),
      // Esc closes a popover, and focus goes back to what opened it.
      Popover: Popover.extend({ defaultProps: { returnFocus: true } }),
      Drawer: Drawer.extend({ defaultProps: dialog })
    }
  }
}

/**
 * Mantine's dark variants assume shade 0 is the lightest; the tuples here keep the same job per index in every theme
 * (see above), so in a dark theme each named colour's variants point at the same indices as in light, except where
 * text on the dark ground needs the lighter shade 7 and a hovered fill the darker shade 8.
 */
function darkVariants(name: NamedColor, tuple: MantineColorsTuple): Record<string, string> {
  const v = (i: number): string => `var(--mantine-color-${name}-${i})`
  return {
    [`--mantine-color-${name}-filled`]: v(6),
    [`--mantine-color-${name}-filled-hover`]: v(8),
    [`--mantine-color-${name}-light`]: v(1),
    [`--mantine-color-${name}-light-hover`]: v(2),
    [`--mantine-color-${name}-light-color`]: v(9),
    [`--mantine-color-${name}-outline`]: v(7),
    [`--mantine-color-${name}-outline-hover`]: alpha(tuple[7], 0.08),
    [`--mantine-color-${name}-text`]: v(7)
  }
}

// Mantine has no theme field for the page background, default border and the rest of the palette, so set them here.
function cssVariablesResolverOf(def: ThemeDef, scheme: ThemeScheme): CSSVariablesResolver {
  const p = def.palette
  return (theme) => {
    const variables: Record<string, string> = {
      '--mantine-color-body': p.ground,
      '--mantine-color-text': p.text,
      '--mantine-color-bright': p.text,
      '--mantine-color-dimmed': p.dimmed,
      // Placeholder text (the search box) is meaningful, so it gets the dimmed text's colour.
      '--mantine-color-placeholder': p.dimmed,
      '--mantine-color-default': p.surface,
      '--mantine-color-default-hover': p.raised,
      '--mantine-color-default-color': p.text,
      '--mantine-color-default-border': p.border,
      '--mantine-color-anchor': p.anchor,
      '--mantine-color-error': p.error,
      '--mainbus-color-strong-border': p.strongBorder,
      '--mainbus-color-lane': p.lane,
      '--mainbus-color-card-border': p.cardBorder,
      // What Mantine gives a colour with autoContrast; unused while that is off, and kept as it was before themes.
      ...Object.fromEntries(
        NAMED_COLORS.filter((n) => n !== 'green').map((n) => [
          `--mantine-color-${n}-contrast`,
          getContrastColor({ color: def.colors[n][6], theme, autoContrast: true })
        ])
      )
    }
    if (scheme === 'dark') {
      Object.assign(
        variables,
        Object.fromEntries((def.neutral ?? DEFAULT_THEME.colors.dark).map((shade, i) => [`--mantine-color-dark-${i}`, shade])),
        // Mantine's own tuples (Light's and Dark's green) run light to dark, so they keep Mantine's variants.
        ...NAMED_COLORS.filter((n) => def.colors[n] !== DEFAULT_THEME.colors[n]).map((n) => darkVariants(n, def.colors[n])),
        {
          // A dark (black in light) button: in a dark theme a raised neutral, still under white text.
          '--mantine-color-dark-filled': 'var(--mantine-color-dark-4)',
          '--mantine-color-dark-filled-hover': 'var(--mantine-color-dark-5)'
        }
      )
    }
    return { variables: {}, light: scheme === 'light' ? variables : {}, dark: scheme === 'dark' ? variables : {} }
  }
}

export interface MantineThemeOf {
  scheme: ThemeScheme
  theme: MantineThemeOverride
  cssVariablesResolver: CSSVariablesResolver
}

/** The MantineProvider's theme and resolver for each theme, made once. */
export const mantineThemes = Object.fromEntries(
  THEMES.map((t) => [
    t.id,
    { scheme: t.scheme, theme: mantineTheme(themes[t.id], t.scheme), cssVariablesResolver: cssVariablesResolverOf(themes[t.id], t.scheme) }
  ])
) as Record<ThemeId, MantineThemeOf>
