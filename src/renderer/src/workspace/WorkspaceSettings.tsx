import { ActionIcon, Drawer, Group, Stack, Text, Title } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import type { AllowRule } from '../../../shared/domain'
import { invoke } from '../api'
import { showError } from '../notify'
import { ConnectAgents } from './ConnectAgents'
import { GeneralSettings } from './GeneralSettings'
import { LineupSettings } from './LineupSettings'
import { PullRequestSettings } from './PullRequestSettings'
import { ReportSettings } from './ReportSettings'
import { BaseTestsSettings } from './BaseTestsSettings'
import { SetupSettings } from './SetupSettings'

interface Props {
  opened: boolean
  onClose: () => void
}

/** An exact rule is stored as "=" + command; a null pattern covers the whole tool. */
function describeRule(rule: AllowRule): string {
  if (rule.pattern === null) return `${rule.toolName}: any use`
  if (rule.pattern.startsWith('=')) return `${rule.toolName}: ${rule.pattern.slice(1)} (exact)`
  return `${rule.toolName}: ${rule.pattern}`
}

export function WorkspaceSettings({ opened, onClose }: Props): ReactElement {
  const [rules, setRules] = useState<AllowRule[]>([])

  useEffect(() => {
    if (!opened) return
    let cancelled = false
    void invoke('allowRules.list')
      .then((list) => {
        if (!cancelled) setRules(list)
      })
      .catch((err) => {
        if (!cancelled) showError(err, 'Could not load the settings')
      })
    return () => {
      cancelled = true
    }
  }, [opened])

  async function remove(rule: AllowRule): Promise<void> {
    try {
      await invoke('allowRules.remove', rule.id)
      setRules((current) => current.filter((r) => r.id !== rule.id))
    } catch (err) {
      showError(err, 'Could not remove the rule')
    }
  }

  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="xl" title="Workspace settings">
      <Stack gap="xl">
        <GeneralSettings opened={opened} />

        <LineupSettings opened={opened} />

        <PullRequestSettings opened={opened} />

        <ReportSettings opened={opened} />

        <SetupSettings opened={opened} />

        <BaseTestsSettings opened={opened} />

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
                  <span aria-hidden>×</span>
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
