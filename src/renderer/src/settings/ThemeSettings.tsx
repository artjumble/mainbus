import { SegmentedControl, Stack, Text } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { useEffect, useState, type ReactElement } from 'react'
import { isThemeId, resolveTheme, THEME_CHOICES, type ThemeChoice, type ThemeScheme, type ThemeSetting } from '../../../shared/domain'
import { invoke } from '../api'
import { showError } from '../notify'
import targets from '../targets.module.css'
import { ThemePicker } from './ThemePicker'

/** The Theme setting: one theme, or Match Windows with a theme for each Windows scheme. */
export function ThemeSettings({ opened }: { opened: boolean }): ReactElement {
  const [theme, setTheme] = useState<ThemeSetting | null>(null)
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)', undefined, { getInitialValueInEffect: false })

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

  const matchWindows = theme?.choice === 'system'

  function changeMode(mode: string): void {
    if (!theme) return
    if (mode === 'system' && !matchWindows) void saveTheme('system')
    // Back to a single theme: keep the one in use, so the look does not jump.
    if (mode === 'single' && matchWindows) void saveTheme(resolveTheme(theme, systemDark))
  }

  return (
    <Stack gap="xs">
      <Text size="sm" fw={500}>
        Theme
      </Text>
      <SegmentedControl
        aria-label="Theme"
        value={matchWindows ? 'system' : 'single'}
        onChange={changeMode}
        disabled={theme === null}
        classNames={{ label: targets.option }}
        data={[
          { value: 'single', label: 'Single theme' },
          { value: 'system', label: 'Match Windows' }
        ]}
      />
      {theme && matchWindows ? (
        // Which theme Match Windows uses while Windows is light, and while it is dark.
        <>
          <ThemePicker
            label="When Windows is light"
            schemes={['light']}
            value={theme.light}
            onChange={(id) => void saveMatchWindows('light', id)}
          />
          <ThemePicker
            label="When Windows is dark"
            schemes={['dark']}
            value={theme.dark}
            onChange={(id) => void saveMatchWindows('dark', id)}
          />
        </>
      ) : (
        <ThemePicker
          label="Theme"
          hideLabel
          schemes={['light', 'dark']}
          value={theme && isThemeId(theme.choice) ? theme.choice : 'light'}
          disabled={theme === null}
          onChange={(id) => void saveTheme(id)}
        />
      )}
    </Stack>
  )
}
