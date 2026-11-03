import {
  ActionIcon,
  Anchor,
  Button,
  CloseButton,
  Drawer,
  Loader,
  Menu,
  Modal,
  UnstyledButton,
  type CSSVariablesResolver,
  type MantineColorsTuple,
  type MantineThemeOverride
} from '@mantine/core'
import targets from './targets.module.css'

// Wireframe palette. Index 6 is the shade Mantine uses for filled variants.
const needs: MantineColorsTuple = [
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

const working: MantineColorsTuple = [
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
const gray: MantineColorsTuple = [
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
const red: MantineColorsTuple = [
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
const yellow: MantineColorsTuple = [
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

export const palette = {
  ground: '#F4F4F1',
  text: '#1F1F1F',
  border: '#CFCFCA'
} as const

export const theme: MantineThemeOverride = {
  fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  headings: { fontFamily: 'inherit' },
  primaryColor: 'working',
  primaryShade: 6,
  black: palette.text,
  colors: { needs, working, gray, red, yellow },
  other: palette,
  // Transitions (menus, modals, collapses) and Mantine's own animations stop for people who ask for less motion.
  respectReducedMotion: true,
  components: {
    // Controls smaller than 44 px get a hit area of that size (see targets.module.css).
    Button: Button.extend({ classNames: { root: targets.target } }),
    ActionIcon: ActionIcon.extend({ classNames: { root: targets.target } }),
    CloseButton: CloseButton.extend({ classNames: { root: targets.target } }),
    UnstyledButton: UnstyledButton.extend({ classNames: { root: targets.target } }),
    Anchor: Anchor.extend({ classNames: { root: targets.target } }),
    Menu: Menu.extend({ classNames: { item: targets.menuItem } }),
    Loader: Loader.extend({ classNames: { root: targets.loader } }),
    // Mantine's close buttons have no name of their own.
    Modal: Modal.extend({ defaultProps: { closeButtonProps: { 'aria-label': 'Close' } } }),
    Drawer: Drawer.extend({ defaultProps: { closeButtonProps: { 'aria-label': 'Close' } } })
  }
}

// Mantine has no theme field for the page background or default border, so set them here.
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    '--mantine-color-body': palette.ground,
    '--mantine-color-text': palette.text,
    '--mantine-color-default-border': palette.border,
    // Placeholder text (the search box) is meaningful, so it gets the same darker grey as dimmed text.
    '--mantine-color-placeholder': 'var(--mantine-color-gray-6)'
  },
  dark: {}
})
