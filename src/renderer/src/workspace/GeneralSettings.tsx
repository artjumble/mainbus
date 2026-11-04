import { Box, Group, NumberInput, Radio, Stack, Text, Title } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import {
  AGENT_CAP_MAX,
  AGENT_CAP_MIN,
  isThemeId,
  THEME_CHOICES,
  THEMES,
  type ThemeChoice,
  type ThemeId,
  type ThemeInfo,
  type ThemeScheme,
  type ThemeSetting,
  type WhenClosed
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

/**
 * Settings section for what applies to the whole app: how many role agents may run at once, what closing the window
 * does, and the theme.
 */
export function GeneralSettings({ opened }: { opened: boolean }): ReactElement {
  const [maxAgents, setMaxAgents] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [whenClosed, setWhenClosed] = useState<WhenClosed | null>(null)
  const [theme, setTheme] = useState<ThemeSetting | null>(null)

  useEffect(() => {
    if (!opened) return
    let cancelled = false
    invoke('settings.get')
      .then((settings) => {
        if (cancelled || !settings) return
        setMaxAgents(settings.maxAgents)
        setWhenClosed(settings.whenClosed)
        setTheme(settings.theme)
      })
      .catch((err) => {
        if (!cancelled) showError(err, 'Could not load the settings')
      })
    return () => {
      cancelled = true
    }
  }, [opened])

  async function save(value: string | number): Promise<void> {
    // Typing is free; only a whole number in range is saved. Anything else waits for the next keystroke.
    if (typeof value !== 'number' || !Number.isInteger(value) || value < AGENT_CAP_MIN || value > AGENT_CAP_MAX) return
    const previous = maxAgents
    setMaxAgents(value)
    setSaving(true)
    try {
      const settings = await invoke('settings.setMaxAgents', value)
      setMaxAgents(settings.maxAgents)
    } catch (err) {
      setMaxAgents(previous)
      showError(err, 'Could not save the settings')
    } finally {
      setSaving(false)
    }
  }

  async function saveWhenClosed(value: string): Promise<void> {
    if (value !== 'tray' && value !== 'quit') return
    const previous = whenClosed
    setWhenClosed(value)
    try {
      const settings = await invoke('settings.setWhenClosed', value)
      setWhenClosed(settings.whenClosed)
    } catch (err) {
      setWhenClosed(previous)
      showError(err, 'Could not save the settings')
    }
  }

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
    <Stack gap="sm" component="section" aria-label="General">
      <Title order={3} size="h4">
        General
      </Title>
      <NumberInput
        label="Agents running at once"
        description="More than this wait as Queued and start first in, first out as others finish. The orchestrator doesn't count. Lowering it stops no running agent."
        min={AGENT_CAP_MIN}
        max={AGENT_CAP_MAX}
        allowDecimal={false}
        allowNegative={false}
        clampBehavior="strict"
        value={maxAgents ?? ''}
        disabled={maxAgents === null || saving}
        onChange={(v) => void save(v)}
        w={160}
      />
      <Radio.Group
        label="When I close the window"
        value={whenClosed ?? ''}
        onChange={(v) => void saveWhenClosed(v)}
      >
        <Stack gap="xs" mt="xs">
          <Radio value="tray" label="Keep running in the tray while agents work" disabled={whenClosed === null} />
          <Radio value="quit" label="Always quit" disabled={whenClosed === null} />
        </Stack>
      </Radio.Group>
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
    </Stack>
  )
}
