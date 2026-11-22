import { Anchor, Box, Group, Select, Stack, Text, VisuallyHidden } from '@mantine/core'
import type { ReactElement } from 'react'
import { THEMES, type ThemeId, type ThemeScheme } from '../../../shared/domain'
import { themes } from '../theme'
import targets from '../targets.module.css'

const GROUPS: readonly { scheme: ThemeScheme; heading: string }[] = [
  { scheme: 'light', heading: 'Light' },
  { scheme: 'dark', heading: 'Dark' }
]

/** A small preview of a theme, in its own colors: ground, surface, text, Working and Needs you. Decoration only. */
export function ThemeSwatch({ id }: { id: ThemeId }): ReactElement | null {
  const def = themes[id]
  if (!def) return null
  const { palette, colors } = def
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

/**
 * A searchable list of themes, grouped under Light and Dark and read from the THEMES registry, so a new theme needs
 * no change here. `schemes` limits which themes are offered. The selected theme's credit shows below the field.
 */
export function ThemePicker({
  label,
  value,
  schemes,
  onChange,
  disabled,
  hideLabel
}: {
  label: string
  value: ThemeId
  schemes: readonly ThemeScheme[]
  onChange: (id: ThemeId) => void
  disabled?: boolean
  /** Name the field for screen readers only, when a heading nearby already shows it. */
  hideLabel?: boolean
}): ReactElement {
  const data = GROUPS.filter((g) => schemes.includes(g.scheme))
    .map((g) => ({
      group: g.heading,
      items: THEMES.filter((t) => t.scheme === g.scheme).map((t) => ({ value: t.id, label: t.name }))
    }))
    .filter((g) => g.items.length > 0)
  const credit = themes[value]?.credit
  return (
    <Stack gap={4}>
      <Select
        label={hideLabel ? undefined : label}
        aria-label={hideLabel ? label : undefined}
        value={value}
        data={data}
        searchable
        allowDeselect={false}
        disabled={disabled}
        maxDropdownHeight={300}
        nothingFoundMessage="No theme matches"
        comboboxProps={{ withinPortal: true }}
        classNames={{ option: targets.option }}
        leftSection={<ThemeSwatch id={value} />}
        leftSectionWidth={80}
        leftSectionPointerEvents="none"
        renderOption={({ option }) => {
          const scheme = THEMES.find((t) => t.id === option.value)?.scheme
          return (
            <Group gap="xs" wrap="nowrap">
              <ThemeSwatch id={option.value as ThemeId} />
              <span>
                {option.label}
                {scheme && <VisuallyHidden component="span">, {scheme}</VisuallyHidden>}
              </span>
            </Group>
          )
        }}
        onChange={(v) => {
          if (v !== null) onChange(v as ThemeId)
        }}
      />
      {credit && (
        <Text size="xs" c="dimmed">
          Theme colors by {credit.author} ({credit.license}),{' '}
          <Anchor href={credit.url} target="_blank" rel="noopener noreferrer" inherit>
            source
          </Anchor>
          .
        </Text>
      )}
    </Stack>
  )
}
