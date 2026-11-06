import { Box, Group, Radio, Stack, Text } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import {
  isThemeId,
  THEME_CHOICES,
  THEMES,
  type ThemeChoice,
  type ThemeId,
  type ThemeInfo,
  type ThemeScheme,
  type ThemeSetting
} from '../../../shared/domain'
import { invoke } from '../api'
import { showError } from '../notify'
import { themes } from '../theme'

const SCHEME_LABELS: Record<ThemeScheme, string> = { light: 'Light theme', dark: 'Dark theme' }

/** A small preview of a theme, in its own colours: ground, surface, text, Working and Needs you. Decoration only. */
function ThemeSwatch({ id }: { id: ThemeId }): ReactElement {
  const { palette, colors } = themes[id]
  return (
    <Group
      gap={0}
      wrap="nowrap"
      aria-hidden
      data-theme-swatch={id}
      style={{ border: `1px solid ${palette.border}`, borderRadius: 'var(--mantine-radius-xs)', overflow: 'hidden', flexShrink: 0 }}
    >
      {[palette.ground, palette.surface, palette.text, colors.working[6], colors.needs[6]].map((c, i) => (
        <Box key={i} w={12} h={16} bg={c} />
      ))}
    </Group>
  )
}

/** A theme's radio label: its swatch and its name, which alone is the radio's accessible name. */
function ThemeLabel({ theme }: { theme: ThemeInfo }): ReactElement {
  return (
    <Group gap="xs" wrap="nowrap" component="span">
      <ThemeSwatch id={theme.id} />
      {theme.name}
    </Group>
  )
}

/** The Theme setting: a theme, or Match Windows with a theme for each Windows scheme. */
export function ThemeSettings({ opened }: { opened: boolean }): ReactElement {
  const [theme, setTheme] = useState<ThemeSetting | null>(null)

  useEffect(() => {
    if (!opened) return
    let cancelled = false
    invoke('settings.get')
      .then((settings) => {
        if (cancelled || !settings) return
        setTheme(settings.theme)
      })
      .catch((err) => {
        if (!cancelled) showError(err, 'Could not load the settings')
      })
    return () => {
      cancelled = true
    }
  }, [opened])

  // The app switches theme when the engine says the setting changed, so the window and the page change together.
  async function saveTheme(value: string): Promise<void> {
    if (!theme || !THEME_CHOICES.includes(value as ThemeChoice)) return
    const previous = theme
    setTheme({ ...theme, choice: value as ThemeChoice })
    try {
      const settings = await invoke('settings.setTheme', value as ThemeChoice)
      setTheme(settings.theme)
    } catch (err) {
      setTheme(previous)
      showError(err, 'Could not save the settings')
    }
  }

  async function saveMatchWindows(scheme: ThemeScheme, value: string): Promise<void> {
    if (!theme || !isThemeId(value)) return
    const previous = theme
    setTheme({ ...theme, [scheme]: value })
    try {
      const settings = await invoke('settings.setMatchWindowsTheme', scheme, value)
      setTheme(settings.theme)
    } catch (err) {
      setTheme(previous)
      showError(err, 'Could not save the settings')
    }
  }

  return (
    <>
      <Radio.Group label="Theme" value={theme?.choice ?? ''} onChange={(v) => void saveTheme(v)}>
        <Stack gap="xs" mt="xs">
          {THEMES.map((t) => (
            <Radio key={t.id} value={t.id} label={<ThemeLabel theme={t} />} disabled={theme === null} />
          ))}
          <Radio value="system" label="Match Windows" disabled={theme === null} />
        </Stack>
      </Radio.Group>
      {theme?.choice === 'system' && (
        // Which theme Match Windows uses while Windows is light, and while it is dark.
        <Stack gap="sm" pl="xl">
          {(['light', 'dark'] as const).map((scheme) => (
            <Radio.Group key={scheme} label={SCHEME_LABELS[scheme]} value={theme[scheme]} onChange={(v) => void saveMatchWindows(scheme, v)}>
              <Stack gap="xs" mt="xs">
                {THEMES.filter((t) => t.scheme === scheme).map((t) => (
                  <Radio key={t.id} value={t.id} label={<ThemeLabel theme={t} />} />
                ))}
              </Stack>
            </Radio.Group>
          ))}
        </Stack>
      )}
      <Text size="xs" c="dimmed">
        Night Owl and Light Owl theme colours by Sarah Drasner (MIT).
      </Text>
    </>
  )
}
