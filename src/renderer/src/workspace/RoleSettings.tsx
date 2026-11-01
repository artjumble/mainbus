import { ActionIcon, Button, Drawer, Group, NativeSelect, Stack, Text, Textarea, Title } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import type { AllowRule, Effort, Role } from '../../../shared/domain'
import { invoke } from '../api'
import { showError } from '../notify'
import { ConnectAgents } from './ConnectAgents'
import { PullRequestSettings } from './PullRequestSettings'

interface Props {
  opened: boolean
  onClose: () => void
}

/** "" stands for null ("Orchestrator decides"), which a native select cannot hold as a value. */
const DEFAULT = ''
const MODELS = [
  { value: DEFAULT, label: 'Orchestrator decides' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' }
]
const EFFORTS = [
  { value: DEFAULT, label: 'Orchestrator decides' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]

/** The options plus, when the stored value isn't one of them, that value, so the select never misreports it. */
function withCurrent(options: { value: string; label: string }[], current: string): { value: string; label: string }[] {
  return options.some((o) => o.value === current) ? options : [...options, { value: current, label: current }]
}

/** An exact rule is stored as "=" + command; a null pattern covers the whole tool. */
function describeRule(rule: AllowRule): string {
  if (rule.pattern === null) return `${rule.toolName}: any use`
  if (rule.pattern.startsWith('=')) return `${rule.toolName}: ${rule.pattern.slice(1)} (exact)`
  return `${rule.toolName}: ${rule.pattern}`
}

export function RoleSettings({ opened, onClose }: Props): ReactElement {
  // The saved role is what Save compares against, and what stays on screen after a save.
  const [saved, setSaved] = useState<Role | null>(null)
  const [instructions, setInstructions] = useState('')
  const [model, setModel] = useState(DEFAULT)
  const [effort, setEffort] = useState(DEFAULT)
  const [rules, setRules] = useState<AllowRule[]>([])
  const [saving, setSaving] = useState(false)

  function adopt(role: Role): void {
    setSaved(role)
    setInstructions(role.instructions)
    setModel(role.model ?? DEFAULT)
    setEffort(role.effort ?? DEFAULT)
  }

  useEffect(() => {
    if (!opened) return
    let cancelled = false
    void Promise.all([invoke('role.get'), invoke('allowRules.list')])
      .then(([role, list]) => {
        if (cancelled) return
        adopt(role)
        setRules(list)
      })
      .catch((err) => {
        if (!cancelled) showError(err, 'Could not load the settings')
      })
    return () => {
      cancelled = true
    }
  }, [opened])

  const dirty =
    saved !== null &&
    (instructions !== saved.instructions || model !== (saved.model ?? DEFAULT) || effort !== (saved.effort ?? DEFAULT))

  async function save(): Promise<void> {
    if (!dirty || saving) return
    setSaving(true)
    try {
      adopt(
        await invoke('role.update', {
          instructions,
          model: model === DEFAULT ? null : model,
          effort: effort === DEFAULT ? null : (effort as Effort)
        })
      )
    } catch (err) {
      showError(err, 'Could not save the settings')
    } finally {
      setSaving(false)
    }
  }

  async function remove(rule: AllowRule): Promise<void> {
    try {
      await invoke('allowRules.remove', rule.id)
      setRules((current) => current.filter((r) => r.id !== rule.id))
    } catch (err) {
      showError(err, 'Could not remove the rule')
    }
  }

  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="md" title="Workspace settings">
      <Stack gap="xl">
        <Stack gap="sm">
          <Title order={3} size="h4">
            Implementer
          </Title>
          <Textarea
            label="Instructions"
            autosize
            minRows={6}
            maxRows={16}
            value={instructions}
            onChange={(e) => setInstructions(e.currentTarget.value)}
          />
          <NativeSelect
            label="Model"
            data={withCurrent(MODELS, model)}
            value={model}
            onChange={(e) => setModel(e.currentTarget.value)}
          />
          <NativeSelect
            label="Effort"
            data={withCurrent(EFFORTS, effort)}
            value={effort}
            onChange={(e) => setEffort(e.currentTarget.value)}
          />
          <Text size="sm" c="dimmed">
            For now, "Orchestrator decides" means Claude Code's default, because there is no orchestrator yet.
          </Text>
          <Group justify="flex-end">
            <Button onClick={() => void save()} disabled={!dirty} loading={saving}>
              Save
            </Button>
          </Group>
        </Stack>

        <PullRequestSettings opened={opened} />

        <Stack gap="sm">
          <Title order={3} size="h4">
            Always allowed in this workspace
          </Title>
          {rules.length === 0 ? (
            <Text size="sm" c="dimmed">
              Nothing is always allowed yet. Choose "Always allow in this workspace" on a permission request to add one.
            </Text>
          ) : (
            rules.map((rule) => (
              <Group key={rule.id} justify="space-between" wrap="nowrap">
                <Text size="sm" ff="monospace" style={{ wordBreak: 'break-word' }}>
                  {describeRule(rule)}
                </Text>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label={`Remove ${describeRule(rule)}`}
                  onClick={() => void remove(rule)}
                >
                  ×
                </ActionIcon>
              </Group>
            ))
          )}
        </Stack>

        <ConnectAgents opened={opened} />
      </Stack>
    </Drawer>
  )
}
