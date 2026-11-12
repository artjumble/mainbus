import { Alert, Button, Group, Select, Stack, Text } from '@mantine/core'
import { useState, type ReactElement } from 'react'
import type { BaseBranchChoice } from '../../../shared/api'
import { addBaseQuestion } from '../../../shared/baseBranch'
import { errorMessage } from '../notify'
import { useMainbus } from '../store'

/** The branch options, each with a mark when origin has it too. */
export function branchSelectData(choice: Pick<BaseBranchChoice, 'branches'>, extra?: string): { value: string; label: string }[] {
  const data = choice.branches.map((b) => ({ value: b.name, label: b.onRemote ? `${b.name} · on origin` : b.name }))
  if (extra && !choice.branches.some((b) => b.name === extra)) data.unshift({ value: extra, label: `${extra} · missing` })
  return data
}

/**
 * Add workspace, when the base branch needs a word: the checkout isn't on the repo's default branch, or a removed workspace
 * of this repo comes back with a base that is gone or differs. The folder opens with the branch chosen here.
 */
export function BaseBranchStep({
  folder,
  choice,
  onDone,
  onCancel
}: {
  folder: string
  choice: BaseBranchChoice
  onDone: () => void
  onCancel: () => void
}): ReactElement {
  const openWorkspace = useMainbus((s) => s.openWorkspace)
  const question = addBaseQuestion(choice)
  const [value, setValue] = useState(choice.suggested)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await openWorkspace(folder, { baseBranch: value })
      onDone()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Stack gap="md">
      {question === 'differs_from_checkout' && (
        <Text>{`Base branch: ${choice.suggested} (you're on ${choice.current})`}</Text>
      )}
      {question === 'removed_missing' && (
        <Text>
          {`This repo was a workspace before, with the base branch ${choice.removed?.baseBranch}. That branch no longer exists in the repo. Which base branch should it use?`}
        </Text>
      )}
      {question === 'removed_differs' && (
        <Text>
          {`This repo was a workspace before, with the base branch ${choice.removed?.baseBranch}. The repo's default branch is ${choice.suggested}. Which base branch should it use?`}
        </Text>
      )}
      <Select
        label={question === 'differs_from_checkout' ? 'Choose another' : 'Base branch'}
        description="New tickets branch from it, and pull requests open against it."
        data={branchSelectData(choice)}
        value={value}
        onChange={(v) => v && setValue(v)}
        allowDeselect={false}
        comboboxProps={{ withinPortal: false }}
      />
      {error && (
        <Alert color="red" role="alert">
          {error}
        </Alert>
      )}
      <Group justify="flex-end">
        <Button variant="default" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => void add()} loading={busy}>
          Add workspace
        </Button>
      </Group>
    </Stack>
  )
}
