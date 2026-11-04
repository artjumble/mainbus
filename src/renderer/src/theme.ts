import {
  ActionIcon,
  alpha,
  Anchor,
  Button,
  CloseButton,
  Drawer,
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
  virtualColor,
  type CSSVariablesResolver,
  type MantineColorsTuple,
  type MantineThemeOverride
} from '@mantine/core'
import { GROUND } from '../../shared/domain'
import targets from './targets.module.css'

// Every colour of the app is here. Each named colour has a light tuple and a dark one, and Mantine's virtualColor gives
// `needs`, `working`, `gray`, `red` and `yellow` the one of the scheme in use, so components name a colour once.

// Wireframe palette. Index 6 is the shade Mantine uses for filled variants.
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

/*
 * The dark tuples keep the jobs the app gives each index in light, so `needs.0`, `needs.7` or `working-5` work in
 * both schemes: 0 a tinted ground (the Needs you column, a permission card), 1 and 2 a chip and a hovered chip, 5 the
 * focus ring and other marks, 6 a fill under white text and a meaningful border, 7 text on the ground, 8 a hovered
 * fill, 9 a chip's text. Index 6 is the light hue, or close to it, so the orange and blue read as the same colours.
 */
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
 * Mantine's own neutral ramp, which its components use in the dark scheme (dark-0 text, dark-2 dimmed, dark-4 borders,
 * dark-5 hover, dark-6 inputs and cards, dark-7 the body). Warm, like the light ground. Set only in the dark scheme:
 * light keeps Mantine's, which a few light things use (the dashed border of a failed card, a dark button).
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

/** The wireframe palette of each scheme: the page ground, surfaces (inputs, cards, menus), text, dimmed text and borders. */
export const palettes = {
  light: {
    ground: GROUND.light,
    surface: '#ffffff',
    text: '#1F1F1F',
    dimmed: grayLight[6],
    border: '#CFCFCA'
  },
  dark: {
    ground: neutralDark[7],
    surface: neutralDark[6],
    text: neutralDark[0],
    dimmed: neutralDark[2],
    border: neutralDark[4]
  }
} as const

/** The light and dark tuple of each named colour. */
export const schemeColors = {
  needs: { light: needsLight, dark: needsDark },
  working: { light: workingLight, dark: workingDark },
  gray: { light: grayLight, dark: grayDark },
  red: { light: redLight, dark: redDark },
  yellow: { light: yellowLight, dark: yellowDark }
} as const

type SchemeColor = keyof typeof schemeColors

const colors = Object.fromEntries(
  Object.entries(schemeColors).flatMap(([name, { light, dark }]) => [
    [name, virtualColor({ name, light: `${name}Light`, dark: `${name}Dark` })],
    [`${name}Light`, light],
    [`${name}Dark`, dark]
  ])
) as Record<SchemeColor, MantineColorsTuple>

// Mantine's close buttons have no name of their own, and its dialog title bar is a <header>, which would be a
// second banner landmark next to the app's.
const dialog = { closeButtonProps: { 'aria-label': 'Close' }, attributes: { header: { role: 'presentation' } } }

export const theme: MantineThemeOverride = {
  fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  headings: { fontFamily: 'inherit' },
  primaryColor: 'working',
  primaryShade: 6,
  black: palettes.light.text,
  colors,
  other: { palettes },
  // Transitions (menus, modals, collapses) and Mantine's own animations stop for people who ask for less motion.
  respectReducedMotion: true,
  components: {
    // Controls smaller than 44 px get a hit area of that size (see targets.module.css).
    Button: Button.extend({ classNames: { root: targets.target } }),
    ActionIcon: ActionIcon.extend({ classNames: { root: targets.target } }),
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

/**
 * Mantine's dark variants assume shade 0 is the lightest; the dark tuples here keep light's jobs per index instead
 * (see above), so each named colour's variants point at the same indices as in light, except where text on the
 * dark ground needs the lighter shade 7 and a hovered fill the darker shade 8.
 */
function darkVariants(name: SchemeColor): Record<string, string> {
  const v = (i: number): string => `var(--mantine-color-${name}-${i})`
  return {
    [`--mantine-color-${name}-filled`]: v(6),
    [`--mantine-color-${name}-filled-hover`]: v(8),
    [`--mantine-color-${name}-light`]: v(1),
    [`--mantine-color-${name}-light-hover`]: v(2),
    [`--mantine-color-${name}-light-color`]: v(9),
    [`--mantine-color-${name}-outline`]: v(7),
    [`--mantine-color-${name}-outline-hover`]: alpha(schemeColors[name].dark[7], 0.08),
    [`--mantine-color-${name}-text`]: v(7)
  }
}

// Mantine has no theme field for the page background or default border, so set them here, with what the dark scheme needs.
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    '--mantine-color-body': palettes.light.ground,
    '--mantine-color-text': palettes.light.text,
    '--mantine-color-default-border': palettes.light.border,
    // Placeholder text (the search box) is meaningful, so it gets the same darker grey as dimmed text.
    '--mantine-color-placeholder': 'var(--mantine-color-gray-6)',
    // The dashed border of a failed card.
    '--mainbus-color-strong-border': 'var(--mantine-color-dark-6)'
  },
  dark: {
    ...Object.fromEntries(neutralDark.map((shade, i) => [`--mantine-color-dark-${i}`, shade])),
    '--mantine-color-body': palettes.dark.ground,
    '--mantine-color-text': palettes.dark.text,
    '--mantine-color-bright': palettes.dark.text,
    '--mantine-color-dimmed': palettes.dark.dimmed,
    '--mantine-color-placeholder': palettes.dark.dimmed,
    '--mantine-color-default': palettes.dark.surface,
    '--mantine-color-default-hover': 'var(--mantine-color-dark-5)',
    '--mantine-color-default-color': palettes.dark.text,
    '--mantine-color-default-border': palettes.dark.border,
    '--mantine-color-anchor': 'var(--mantine-color-working-7)',
    '--mantine-color-error': 'var(--mantine-color-red-7)',
    '--mainbus-color-strong-border': palettes.dark.dimmed,
    ...Object.assign({}, ...(Object.keys(schemeColors) as SchemeColor[]).map(darkVariants)),
    // A dark (black in light) button: in the dark scheme a raised grey, still under white text.
    '--mantine-color-dark-filled': 'var(--mantine-color-dark-4)',
    '--mantine-color-dark-filled-hover': 'var(--mantine-color-dark-5)'
  }
})
