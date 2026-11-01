import { Stack, Switch, Text, Title } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import type { GhStatus, Workspace } from '../../../shared/domain'
import { invoke } from '../api'
import { showError } from '../notify'
import { useMainbus } from '../store'

/** Settings section: the switch that has Mainbus push a handed-off ticket's branch and open its PR. */
export function PullRequestSettings({ opened }: { opened: boolean }): ReactElement {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [saving, setSaving] = useState(false)
  const [gh, setGh] = useState<GhStatus | null>(null)
  const on = workspace?.openPrOnReview === true

  useEffect(() => {
    if (!opened) return
    let cancelled = false
    invoke('workspace.get')
      .then((ws) => {
        if (!cancelled) setWorkspace(ws ?? null)
      })
      .catch((err) => {
        if (!cancelled) showError(err, 'Could not load the settings')
      })
    return () => {
      cancelled = true
    }
  }, [opened])

  // Only worth saying while the switch is on: then a missing or signed-out gh means no PR.
  useEffect(() => {
    setGh(null)
    if (!opened || !on) return
    let cancelled = false
    invoke('github.check')
      .then((status) => {
        if (!cancelled) setGh(status ?? null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [opened, on])

  async function toggle(next: boolean): Promise<void> {
    setSaving(true)
    try {
      const ws = await invoke('workspace.setOpenPrOnReview', next)
      setWorkspace(ws)
      useMainbus.setState({ workspace: ws })
    } catch (err) {
      showError(err, 'Could not save the settings')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Stack gap="sm" component="section" aria-label="Pull requests">
      <Title order={3} size="h4">
        Pull requests
      </Title>
      <Switch
        label="Open a PR when a ticket reaches Review"
        description={`Mainbus pushes the ticket's branch to origin and opens a pull request against ${
          workspace?.baseBranch ?? 'the base branch'
        } with the GitHub CLI. It never force-pushes, and agents still can't push.`}
        checked={on}
        disabled={workspace === null || saving}
        onChange={(e) => void toggle(e.currentTarget.checked)}
      />
      {gh !== null && !gh.ok && (
        <Text size="sm" c="needs.7">
          {`No PR can be opened: ${gh.reason}.`}
        </Text>
      )}
    </Stack>
  )
}
