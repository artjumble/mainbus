import { Box, Group, Text, Tooltip } from '@mantine/core'
import type { ReactElement } from 'react'
import { categoryLine, exactMinutes, TIME_CATEGORIES, TIME_LABELS, type CategoryMs, type TimeCategory } from '../../../shared/timeBreakdown'

/** One colour per category, from the theme, so it works in light and dark. Waiting is warm, machine time cool, idle grey. */
export const TIME_COLORS: Record<TimeCategory, string> = {
  permission: 'var(--mantine-color-red-6)',
  question: 'var(--mantine-color-orange-6)',
  paused: 'var(--mantine-color-gray-6)',
  usage_limited: 'var(--mantine-color-yellow-7)',
  queued: 'var(--mantine-color-gray-4)',
  setup: 'var(--mantine-color-lime-7)',
  tests: 'var(--mantine-color-violet-6)',
  build: 'var(--mantine-color-indigo-6)',
  install: 'var(--mantine-color-cyan-7)',
  git: 'var(--mantine-color-teal-6)',
  reading: 'var(--mantine-color-blue-4)',
  editing: 'var(--mantine-color-green-6)',
  web: 'var(--mantine-color-pink-5)',
  mainbus: 'var(--mantine-color-grape-5)',
  other_tool: 'var(--mantine-color-yellow-5)',
  model: 'var(--mantine-color-blue-7)',
  between: 'var(--mantine-color-gray-3)'
}

/** A stacked bar of the categories that have time; each segment says its category and exact minutes on hover. */
export function TimeBar({ label, byCategory, totalMs }: { label: string; byCategory: CategoryMs; totalMs: number }): ReactElement {
  const shown = TIME_CATEGORIES.filter((c) => byCategory[c.id] > 0)
  return (
    <Box
      role="img"
      aria-label={`${label}: ${categoryLine(byCategory) || 'no time'}`}
      style={{ display: 'flex', height: 14, borderRadius: 3, overflow: 'hidden', background: 'var(--mantine-color-default-border)' }}
    >
      {shown.map((c) => (
        <Tooltip key={c.id} label={`${TIME_LABELS[c.id]}: ${exactMinutes(byCategory[c.id])}`} withinPortal>
          <Box data-category={c.id} style={{ width: `${(byCategory[c.id] / Math.max(1, totalMs)) * 100}%`, background: TIME_COLORS[c.id], minWidth: 1 }} />
        </Tooltip>
      ))}
    </Box>
  )
}

/** The colour key for the categories that have time anywhere in `byCategory`. */
export function TimeLegend({ byCategory }: { byCategory: CategoryMs }): ReactElement {
  return (
    <Group gap="sm" role="list" aria-label="Time categories">
      {TIME_CATEGORIES.filter((c) => byCategory[c.id] > 0).map((c) => (
        <Group key={c.id} gap={4} role="listitem" wrap="nowrap">
          <Box style={{ width: 8, height: 8, borderRadius: 2, background: TIME_COLORS[c.id], flexShrink: 0 }} />
          <Text size="xs" c="dimmed">
            {c.label}
          </Text>
        </Group>
      ))}
    </Group>
  )
}
