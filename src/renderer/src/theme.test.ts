import { theme } from './theme'

test('theme carries the wireframe palette', () => {
  expect(theme.colors?.needs?.[6]).toBe('#B5530F') // Needs you orange
  expect(theme.colors?.working?.[6]).toBe('#1E3F99') // Working blue
  expect(theme.fontFamily).toContain('Segoe UI')
})
