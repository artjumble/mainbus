import { Alert, Button, Checkbox, Group, List, Loader, Radio, Stack, Text } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import type { FolderReadiness, SetupPreview, SetupWarning } from '../../../shared/api'
import { invoke } from '../api'
import { errorMessage } from '../notify'
import { useMainbus } from '../store'

const SHOWN = 20

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

function warningText(w: SetupWarning): string {
  switch (w.kind) {
    case 'secret':
      return `${w.path}: looks like a secret`
    case 'generated':
      return `${w.path}/: generated files (${plural(w.files, 'file')}, ${size(w.bytes)})`
    case 'large':
      return `${w.path}: a large file (${size(w.bytes)})`
  }
}

function Capped<T>({ items, render }: { items: T[]; render: (item: T) => string }): ReactElement {
  return (
    <List size="sm" spacing={2}>
      {items.slice(0, SHOWN).map((item, i) => (
        <List.Item key={i}>{render(item)}</List.Item>
      ))}
      {items.length > SHOWN && <List.Item>and {items.length - SHOWN} more</List.Item>}
    </List>
  )
}

function Preview({ preview }: { preview: SetupPreview }): ReactElement {
  return (
    <Stack gap="xs" ml="xl">
      <Text size="sm">
        {plural(preview.files, 'file')}, {size(preview.bytes)}
      </Text>
      {preview.entries.length > 0 && (
        <Capped
          items={preview.entries}
          render={(e) => (e.folder ? `${e.name}/ (${plural(e.files, 'file')})` : e.name)}
        />
      )}
      {preview.warnings.length > 0 && (
        <Alert color="yellow" title="Worth a look before committing" role="group" aria-label="Warnings">
          <Capped items={preview.warnings} render={warningText} />
        </Alert>
      )}
    </Stack>
  )
}

/**
 * Shown when the chosen folder can't open as a workspace yet: says why and, for a folder without a repository or without
 * commits, offers to set git up after the user confirms. Nothing changes until "Set up and add workspace".
 */
export function GitSetup({
  readiness,
  onDone,
  onCancel
}: {
  readiness: FolderReadiness
  onDone: () => void
  onCancel: () => void
}): ReactElement {
  const prepareWorkspace = useMainbus((s) => s.prepareWorkspace)
  const [choice, setChoice] = useState<'files' | 'empty'>('files')
  const [preview, setPreview] = useState<SetupPreview | null>(null)
  const [writeGitignore, setWriteGitignore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canSetUp = readiness.status === 'not_a_repo' || readiness.status === 'no_commits'

  useEffect(() => {
    if (!canSetUp) return
    let current = true
    setPreview(null)
    invoke('workspace.previewSetup', readiness.folder).then(
      (p) => current && setPreview(p),
      (err: unknown) => current && setError(errorMessage(err))
    )
    return () => {
      current = false
    }
  }, [canSetUp, readiness.folder])

  async function setUp(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await prepareWorkspace(readiness.folder, {
        commitFiles: choice === 'files',
        writeGitignore: choice === 'files' && writeGitignore
      })
      onDone()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const why =
    readiness.status === 'not_a_repo'
      ? `${readiness.folder} isn't a git repository yet.`
      : readiness.status === 'no_commits'
        ? `The repository at ${readiness.root} has no commits yet.`
        : `${readiness.root} isn't on a branch (detached HEAD).`

  return (
    <Stack gap="md">
      <Text>{why}</Text>
      {readiness.root !== readiness.folder && (
        <Text size="sm" c="dimmed">
          This folder is inside the repository at {readiness.root}; Mainbus will use {readiness.root}.
        </Text>
      )}
      {readiness.status === 'detached_head' && (
        <Text size="sm">
          Mainbus needs a branch to start tickets from, and picking one is your call. Run <code>git switch &lt;branch&gt;</code> to go
          back to a branch, or <code>git switch -c &lt;name&gt;</code> to start one here, then add the folder again.
        </Text>
      )}
      {canSetUp && (
        <Stack gap="sm" role="group" aria-label="Set up git here">
          <Text fw={600}>Set up git here</Text>
          <Text size="sm" c="dimmed">
            Each ticket gets its own folder and branch, made from a commit. Nothing changes until you confirm.
          </Text>
          <Radio.Group value={choice} onChange={(v) => setChoice(v === 'empty' ? 'empty' : 'files')} name="first-commit">
            <Stack gap="sm">
              <Radio
                value="files"
                label="Commit the folder's current files"
                description="Recommended: agents only see what's committed."
              />
              {choice === 'files' &&
                (preview ? (
                  <Preview preview={preview} />
                ) : error ? null : (
                  <Group ml="xl" gap="xs">
                    <Loader size="xs" />
                    <Text size="sm" c="dimmed">
                      Looking at the files…
                    </Text>
                  </Group>
                ))}
              <Radio value="empty" label="Start with an empty commit" />
              {choice === 'empty' && (
                <Alert color="yellow" ml="xl" role="note">
                  Your existing files won't be in ticket folders until you commit them.
                </Alert>
              )}
            </Stack>
          </Radio.Group>
          {preview && preview.warnings.length > 0 && (
            <Checkbox
              label="Add a .gitignore for the flagged items"
              checked={writeGitignore}
              disabled={choice !== 'files'}
              onChange={(e) => setWriteGitignore(e.currentTarget.checked)}
            />
          )}
        </Stack>
      )}
      {error && (
        <Alert color="red" role="alert" style={{ whiteSpace: 'pre-wrap' }}>
          {error}
        </Alert>
      )}
      <Group justify="flex-end">
        <Button variant="default" onClick={onCancel}>
          Cancel
        </Button>
        {canSetUp && (
          <Button onClick={() => void setUp()} loading={busy}>
            Set up and add workspace
          </Button>
        )}
      </Group>
    </Stack>
  )
}
