import { Button, ColorSwatch, Group, Radio, Stack, Text, TextInput } from '@mantine/core'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  checkRailLabel,
  isRailColor,
  RAIL_COLOR_NAMES,
  RAIL_COLORS,
  railBadges,
  railLabelProblem,
  type RailColor
} from '../../../shared/railBadge'
import { invoke } from '../api'
import { errorMessage, showError } from '../notify'
import { useMainbus } from '../store'
import { RailTile } from './RailTile'
import { RAIL_TILES } from '../theme'

const AUTOMATIC = 'automatic'

/** Settings section: the short label and the colour of the workspace's tile in the rail. */
export function RailBadgeSettings({ opened }: { opened: boolean }): ReactElement | null {
  const workspace = useMainbus((s) => s.workspace)
  const workspaces = useMainbus((s) => s.workspaces)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [rejected, setRejected] = useState<string | null>(null)
  const custom = workspace?.railLabel ?? ''

  // The field starts at the saved label, and follows it when it changes elsewhere.
  useEffect(() => {
    setText(custom)
    setRejected(null)
  }, [custom, opened, workspace?.id])

  const others = useMemo(
    () => workspaces.map((w) => (w.id === workspace?.id ? { ...w, railLabel: workspace.railLabel, railColor: workspace.railColor } : w)),
    [workspaces, workspace]
  )
  const badges = useMemo(() => railBadges(others), [others])
  const automatic = useMemo(
    () => (workspace ? railBadges(others.map((w) => (w.id === workspace.id ? { ...w, railLabel: null, railColor: null } : w))).get(workspace.id) : undefined),
    [others, workspace]
  )

  if (!workspace || !automatic) return null
  const shown = badges.get(workspace.id) ?? automatic
  const trimmed = text.trim()
  const problem = trimmed === '' ? null : (() => {
    const checked = checkRailLabel(trimmed)
    return checked.ok ? railLabelProblem(trimmed, workspace.id, others) : checked.reason
  })()
  const error = problem ?? rejected

  async function save(badge: { label?: string | null; color?: RailColor | null }): Promise<void> {
    setSaving(true)
    setRejected(null)
    try {
      const ws = await invoke('workspace.setRailBadge', badge)
      useMainbus.setState({ workspace: ws })
      await useMainbus.getState().refreshWorkspaces()
    } catch (err) {
      if (badge.label !== undefined) setRejected(errorMessage(err))
      else showError(err, 'Could not save the colour')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Stack gap="xs" aria-label="Rail badge">
      <Group align="flex-start" gap="sm" wrap="nowrap">
        <RailTile label={shown.label} color={shown.color} />
        <TextInput
          label="Short label"
          description={`1 to 3 characters; emoji work too. Leave it empty to use the automatic label, ${automatic.label}.`}
          placeholder={automatic.label}
          value={text}
          onChange={(e) => {
            setText(e.currentTarget.value)
            setRejected(null)
          }}
          error={error}
          style={{ flex: 1 }}
        />
        <Button
          mt={25}
          onClick={() => void save({ label: trimmed === '' ? null : trimmed })}
          loading={saving}
          disabled={problem !== null || trimmed === custom}
        >
          Save label
        </Button>
      </Group>
      <Radio.Group
        label="Colour"
        value={workspace.railColor ?? AUTOMATIC}
        onChange={(value) => void save({ color: isRailColor(value) ? value : null })}
      >
        <Group gap="md" mt={4}>
          <Radio value={AUTOMATIC} label={`Automatic (${RAIL_COLOR_NAMES[automatic.color]})`} disabled={saving} />
          {RAIL_COLORS.map((c) => (
            <Radio
              key={c}
              value={c}
              disabled={saving}
              label={
                <Group gap={6} wrap="nowrap">
                  <ColorSwatch color={RAIL_TILES[c].deep} size={14} aria-hidden />
                  <Text span size="sm">
                    {RAIL_COLOR_NAMES[c]}
                  </Text>
                </Group>
              }
            />
          ))}
        </Group>
      </Radio.Group>
    </Stack>
  )
}
