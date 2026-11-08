import { Alert, Button, Group, Modal, Paper, Stack, Text, TextInput, Title } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import { PRESET_NAME_MAX, type LineupPreset, type LineupRole } from '../../../shared/domain'
import { applyRunSettings, choicesFromSettings, inputFromChoices, runSettingsSummary } from '../../../shared/runSettings'
import { invoke } from '../api'
import { errorMessage, showError } from '../notify'
import type { RoleChoice } from '../ticket/RoleChoice'
import { StartOverrideForm } from '../ticket/StartOverrideForm'

interface Props {
  opened: boolean
  /** Changes when the Change lineup is saved, so the presets are read against the new roles. */
  lineupVersion: number
}

/** What the form is editing: a new preset (no id) or an existing one. */
interface Draft {
  id?: string
  name: string
  roles: RoleChoice[]
  extra: string
}

/**
 * The workspace's presets of run settings for the Change lineup: named templates a ticket can start from. A ticket keeps
 * a copy of the settings it takes, so editing or removing a preset changes no ticket.
 */
export function PresetSettings({ opened, lineupVersion }: Props): ReactElement {
  const [presets, setPresets] = useState<LineupPreset[] | null>(null)
  const [lineup, setLineup] = useState<LineupRole[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!opened) return
    let cancelled = false
    Promise.all([invoke('preset.list'), invoke('lineup.get', 'change')])
      .then(([listed, roles]) => {
        if (cancelled) return
        setPresets(listed)
        setLineup(roles)
      })
      .catch((err: unknown) => {
        if (!cancelled) showError(err, 'Could not load the presets')
      })
    return () => {
      cancelled = true
    }
  }, [opened, lineupVersion])

  function open(preset?: LineupPreset): void {
    setError(null)
    setDraft({
      ...(preset ? { id: preset.id } : {}),
      name: preset?.name ?? '',
      roles: choicesFromSettings(lineup, preset?.settings ?? null),
      extra: preset?.settings.extraInstructions ?? ''
    })
  }

  async function save(): Promise<void> {
    if (!draft || saving) return
    setSaving(true)
    setError(null)
    try {
      await invoke('preset.save', {
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name,
        settings: inputFromChoices(draft.roles, lineup, draft.extra)
      })
      setPresets(await invoke('preset.list'))
      setDraft(null)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  async function remove(preset: LineupPreset): Promise<void> {
    try {
      await invoke('preset.remove', preset.id)
      setPresets(await invoke('preset.list'))
    } catch (err) {
      showError(err, 'Could not remove the preset')
    }
  }

  return (
    <Stack gap="sm" component="section" aria-labelledby="presets-heading">
      <Title order={3} size="h4" id="presets-heading">
        Presets
      </Title>
      <Text size="sm" c="dimmed">
        A preset is a named set of run settings for Change tickets: which roles run, and their models. Pick one when you create a ticket
        or in its Run settings; the ticket keeps its own copy.
      </Text>
      <Stack component="ul" gap={6} aria-label="Presets" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {(presets ?? []).map((preset) => {
          const { options, notices } = applyRunSettings(preset.settings, lineup)
          return (
            <Paper component="li" key={preset.id} withBorder p={6} data-preset={preset.name}>
              <Group gap="sm" wrap="nowrap" align="flex-start">
                <Stack gap={0} flex={1} miw={0}>
                  <Text size="sm" fw={500} truncate>
                    {preset.name}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {runSettingsSummary(options, lineup)}
                  </Text>
                  {notices.map((n) => (
                    <Text key={n} size="xs" c="needs">
                      {n}
                    </Text>
                  ))}
                </Stack>
                <Button size="compact-sm" variant="default" aria-label={`Edit ${preset.name}`} onClick={() => open(preset)}>
                  Edit
                </Button>
                <Button size="compact-sm" variant="default" aria-label={`Remove ${preset.name}`} onClick={() => void remove(preset)}>
                  Remove
                </Button>
              </Group>
            </Paper>
          )
        })}
      </Stack>
      <Button variant="default" onClick={() => open()} styles={{ root: { borderStyle: 'dashed' } }} disabled={lineup.length === 0}>
        <span aria-hidden>+ </span>Add preset
      </Button>

      <Modal opened={draft !== null} onClose={() => setDraft(null)} title={draft?.id ? 'Edit preset' : 'New preset'} size="lg">
        {draft && (
          <Stack gap="sm">
            <TextInput
              label="Name"
              data-autofocus
              maxLength={PRESET_NAME_MAX}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
            />
            <StartOverrideForm
              roles={draft.roles}
              extraInstructions={draft.extra}
              onRolesChange={(roles) => setDraft({ ...draft, roles })}
              onExtraInstructionsChange={(extra) => setDraft({ ...draft, extra })}
              rolesHint="Untick a role to skip it in tickets that use this preset."
              extraHint="Added to every role's instructions in tickets that use this preset."
            />
            {error && (
              <Alert color="needs" title="Could not save the preset">
                {error}
              </Alert>
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button loading={saving} disabled={draft.name.trim() === ''} onClick={() => void save()}>
                Save preset
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  )
}
