import { Button, Group, Stack, Switch, TextInput, Title } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import { checkReportsFolder, type ReportSettingsInput, type Workspace } from '../../../shared/domain'
import { invoke } from '../api'
import { showError } from '../notify'
import { useMainbus } from '../store'

/** Settings section: whether Mainbus commits an Investigate ticket's report on its branch, and the folder it goes in. */
export function ReportSettings({ opened }: { opened: boolean }): ReactElement {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [folder, setFolder] = useState('')
  const [saving, setSaving] = useState(false)
  const on = workspace?.saveReports === true

  useEffect(() => {
    if (!opened) return
    let cancelled = false
    invoke('workspace.get')
      .then((ws) => {
        if (cancelled) return
        setWorkspace(ws ?? null)
        setFolder(ws?.reportsFolder ?? '')
      })
      .catch((err) => {
        if (!cancelled) showError(err, 'Could not load the settings')
      })
    return () => {
      cancelled = true
    }
  }, [opened])

  const checked = checkReportsFolder(folder)
  const changed = workspace !== null && folder.trim() !== workspace.reportsFolder

  async function save(settings: ReportSettingsInput): Promise<void> {
    setSaving(true)
    try {
      const ws = await invoke('workspace.setReportSettings', settings)
      setWorkspace(ws)
      setFolder(ws.reportsFolder)
      useMainbus.setState({ workspace: ws })
    } catch (err) {
      showError(err, 'Could not save the settings')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Stack gap="sm" component="section" aria-label="Investigation reports">
      <Title order={3} size="h4">
        Investigation reports
      </Title>
      <Switch
        label="Save investigation reports in the repo"
        description="When an Investigate ticket submits its report, Mainbus saves it as a markdown file and commits it on the ticket's branch. It reaches the base branch when you merge, like any ticket's work. If the repository is public, so are the reports."
        checked={on}
        disabled={workspace === null || saving}
        onChange={(e) => void save({ saveReports: e.currentTarget.checked })}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (checked.ok && changed) void save({ reportsFolder: folder })
        }}
      >
        <Stack gap="xs">
          <TextInput
            label="Reports folder"
            description="Relative to the repository. Each report is saved as <date>-<ticket number>-<title>.md in it."
            value={folder}
            onChange={(e) => setFolder(e.currentTarget.value)}
            error={workspace !== null && !checked.ok ? checked.reason : undefined}
            disabled={workspace === null || !on}
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          />
          <Group>
            <Button type="submit" variant="default" size="compact-sm" loading={saving} disabled={!on || !checked.ok || !changed}>
              Save folder
            </Button>
          </Group>
        </Stack>
      </form>
    </Stack>
  )
}
