import type { CSSVariablesResolver, MantineColorsTuple, MantineThemeOverride } from '@mantine/core'

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
  colors: { needs, working },
  other: palette
}

// Mantine has no theme field for the page background or default border, so set them here.
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    '--mantine-color-body': palette.ground,
    '--mantine-color-text': palette.text,
    '--mantine-color-default-border': palette.border
  },
  dark: {}
})
