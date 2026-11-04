import { describe, expect, it } from 'vitest'
import { GROUND, resolveTheme, THEME_CHOICES, THEME_IDS, THEME_SETTING_DEFAULT, THEMES, themeOf, type ThemeSetting } from './domain'

describe('the theme registry', () => {
  it('lists Light, Dark, Night Owl and Light Owl, with Light first and the default', () => {
    expect(THEMES.map((t) => [t.id, t.name, t.scheme])).toEqual([
      ['light', 'Light', 'light'],
      ['dark', 'Dark', 'dark'],
      ['night-owl', 'Night Owl', 'dark'],
      ['light-owl', 'Light Owl', 'light']
    ])
    expect(THEME_SETTING_DEFAULT).toEqual({ choice: 'light', light: 'light', dark: 'dark' })
    expect(THEME_CHOICES).toEqual([...THEME_IDS, 'system'])
  })

  it('has a ground for every theme, the one each theme gives, and Light and Dark keep theirs', () => {
    expect(Object.keys(GROUND)).toEqual(THEME_IDS)
    for (const t of THEMES) expect(GROUND[t.id]).toBe(t.ground)
    expect(GROUND.light).toBe('#F4F4F1')
    expect(GROUND.dark).toBe('#1E1E1C')
    expect(GROUND['night-owl']).toBe('#011627')
  })

  it('finds a theme by id', () => {
    expect(themeOf('night-owl').name).toBe('Night Owl')
  })
})

describe('resolveTheme', () => {
  it.each(THEME_IDS.flatMap((id) => [[id, false], [id, true]] as const))('%s draws %s whatever Windows is (dark %s)', (id, systemDark) => {
    expect(resolveTheme({ ...THEME_SETTING_DEFAULT, choice: id }, systemDark)).toBe(id)
  })

  it.each([
    [{ choice: 'system', light: 'light', dark: 'dark' }, false, 'light'],
    [{ choice: 'system', light: 'light', dark: 'dark' }, true, 'dark'],
    [{ choice: 'system', light: 'light-owl', dark: 'night-owl' }, false, 'light-owl'],
    [{ choice: 'system', light: 'light-owl', dark: 'night-owl' }, true, 'night-owl'],
    [{ choice: 'system', light: 'light', dark: 'night-owl' }, true, 'night-owl']
  ] as [ThemeSetting, boolean, string][])('Match Windows %o with Windows dark %s draws %s', (setting, systemDark, expected) => {
    expect(resolveTheme(setting, systemDark)).toBe(expected)
  })
})
