import { Button, Group, Select, Stack, Text } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import { baseBranchWarning } from '../../../shared/baseBranch'
import { invoke } from '../api'
import { showError } from '../notify'
import { useMainbus } from '../store'
import { branchSelectData } from './BaseBranchStep'
import { useWorkspaceBranches } from './useWorkspaceBranches'

/** Settings section: the branch new tickets start from and pull requests open against. */
export function BaseBranchSettings({ opened }: { opened: boolean }): ReactElement | null {
  const workspace = useMainbus((s) => s.workspace)
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)
  const info = useWorkspaceBranches(opened ? workspace?.id : undefined, workspace?.baseBranch, reload)
  const [value, setValue] = useState<string | null>(null)
  const base = workspace?.baseBranch ?? null

  // The select starts at the current base, and follows it when it changes elsewhere.
  useEffect(() => setValue(base), [base, opened])

  if (!workspace) return null

  async function save(): Promise<void> {
    if (!value) return
    setSaving(true)
    try {
      const ws = await invoke('workspace.setBaseBranch', value)
      useMainbus.setState({ workspace: ws })
      setReload((n) => n + 1)
    } catch (err) {
      showError(err, 'Could not save the base branch')
    } finally {
      setSaving(false)
    }
  }

  const warning = info ? baseBranchWarning(info) : null
  const missing = info !== null && !info.branches.some((b) => b.name === base)

  return (
    <Stack gap="xs" aria-label="Base branch">
      <Group align="flex-end" gap="sm">
        <Select
          label="Base branch"
          description="New tickets branch from it, and freshness checks, base-branch tests, merges and new pull requests use it. Existing tickets keep their branches, and their open pull requests aren't retargeted."
          data={info ? branchSelectData(info, missing ? (base ?? undefined) : undefined) : base ? [{ value: base, label: base }] : []}
          value={value}
          onChange={setValue}
          allowDeselect={false}
          disabled={info === null || saving}
          comboboxProps={{ withinPortal: false }}
          style={{ flex: 1 }}
        />
        <Button onClick={() => void save()} loading={saving} disabled={!value || value === base || info === null}>
          Save base branch
        </Button>
      </Group>
      {warning && (
        <Text size="sm" c="needs.7" role="status">
          {warning}
        </Text>
      )}
    </Stack>
  )
}
