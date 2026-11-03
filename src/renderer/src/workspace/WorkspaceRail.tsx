import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Menu,
  Modal,
  Stack,
  Text,
  Tooltip,
  UnstyledButton
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useState, type ReactElement } from 'react'
import type { WorkspaceSummary } from '../../../shared/api'
import { openFolder } from '../api'
import { errorMessage, showError } from '../notify'
import { useMainbus } from '../store'

/** Up to two letters for a narrow rail: the first letters of the first two words, or the name's first two letters. */
export function initials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? name).slice(0, 2)
  return letters.toUpperCase()
}

function describe(w: WorkspaceSummary): string {
  const parts = [w.name]
  if (w.active) parts.push('agents working')
  if (w.needsYou > 0) parts.push(`${w.needsYou} need you`)
  return parts.join(' · ')
}

/** The left rail: every open workspace with its activity and needs-you count, and a way to add one. */
export function WorkspaceRail(): ReactElement {
  const workspaces = useMainbus((s) => s.workspaces)
  const focusedId = useMainbus((s) => s.workspace?.id ?? null)
  const focusWorkspace = useMainbus((s) => s.focusWorkspace)
  const openSettings = useMainbus((s) => s.openSettings)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<WorkspaceSummary | null>(null)

  async function focus(w: WorkspaceSummary): Promise<void> {
    try {
      if (w.id !== focusedId) await focusWorkspace(w.id)
    } catch (err) {
      showError(err, 'Could not switch workspace')
    }
  }

  async function settings(w: WorkspaceSummary): Promise<void> {
    // The settings parts read the focused workspace, so focus it first.
    try {
      if (w.id !== focusedId) await focusWorkspace(w.id)
      openSettings()
    } catch (err) {
      showError(err, 'Could not switch workspace')
    }
  }

  return (
    <Stack component="nav" aria-label="Workspaces" gap="xs" p="xs" h="100%" justify="space-between">
      <Stack gap={4}>
        {workspaces.map((w) => (
          <Group key={w.id} gap={2} wrap="nowrap" justify="space-between">
            <Tooltip label={`${w.name} — ${w.repoPath}`} position="right" openDelay={400}>
              <UnstyledButton
                onClick={() => void focus(w)}
                aria-current={w.id === focusedId ? 'true' : undefined}
                aria-label={describe(w)}
                p={6}
                style={{
                  flex: 1,
                  minWidth: 0,
                  borderRadius: 'var(--mantine-radius-sm)',
                  background: w.id === focusedId ? 'var(--mantine-color-default-hover)' : undefined
                }}
              >
                <Group gap={6} wrap="nowrap">
                  {/* Always laid out, so the name doesn't shift when the dot comes and goes. */}
                  <Box
                    role={w.active ? 'img' : undefined}
                    aria-label={w.active ? 'agents working' : undefined}
                    data-activity={w.active ? '' : undefined}
                    w={8}
                    h={8}
                    style={{
                      flexShrink: 0,
                      borderRadius: '50%',
                      background: w.active ? 'var(--mantine-color-working-filled)' : 'transparent'
                    }}
                  />
                  <Text size="sm" fw={w.id === focusedId ? 700 : 500} truncate visibleFrom="lg">
                    {w.name}
                  </Text>
                  <Text size="sm" fw={w.id === focusedId ? 700 : 500} hiddenFrom="lg">
                    {initials(w.name)}
                  </Text>
                  {w.needsYou > 0 && (
                    <Badge color="needs" variant="filled" circle data-needs-you aria-label={`${w.needsYou} need you`}>
                      {w.needsYou}
                    </Badge>
                  )}
                </Group>
              </UnstyledButton>
            </Tooltip>
            <Menu position="right-start" withinPortal>
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray" size="sm" aria-label={`Options for ${w.name}`}>
                  <span aria-hidden>⋯</span>
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item onClick={() => void settings(w)}>Settings</Menu.Item>
                <Menu.Item color="red" onClick={() => setRemoving(w)}>
                  Remove…
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        ))}
      </Stack>
      <Button variant="default" size="xs" onClick={() => setAdding(true)} aria-label="Add workspace">
        <Text component="span" size="xs" visibleFrom="lg">
          + Add workspace
        </Text>
        <Text component="span" size="xs" hiddenFrom="lg" aria-hidden>
          +
        </Text>
      </Button>
      <AddWorkspaceModal opened={adding} onClose={() => setAdding(false)} />
      <RemoveWorkspaceModal workspace={removing} onClose={() => setRemoving(null)} />
    </Stack>
  )
}

function AddWorkspaceModal({ opened, onClose }: { opened: boolean; onClose: () => void }): ReactElement {
  const openWorkspace = useMainbus((s) => s.openWorkspace)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function choose(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const folder = await openFolder()
      if (!folder) return
      await openWorkspace(folder)
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Add workspace">
      <Stack gap="md">
        <Text>Pick the folder of the git repository you want to work on.</Text>
        <Text size="sm" c="dimmed">
          Claude Code can't ask you to trust a folder while Mainbus runs it, so Mainbus treats the folder you pick as
          trusted. Its agents work in their own copies of the repo, one folder per ticket, never in your checkout.
        </Text>
        {error && (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void choose()} loading={busy}>
            Choose folder…
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

function RemoveWorkspaceModal({
  workspace,
  onClose
}: {
  workspace: WorkspaceSummary | null
  onClose: () => void
}): ReactElement {
  const removeWorkspace = useMainbus((s) => s.removeWorkspace)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function close(): void {
    setError(null)
    onClose()
  }

  async function confirm(): Promise<void> {
    if (!workspace) return
    setBusy(true)
    setError(null)
    try {
      const { keptFolders } = await removeWorkspace(workspace.id)
      if (keptFolders.length > 0) {
        notifications.show({
          color: 'needs',
          title: 'Some ticket folders were left as they are',
          message: keptFolders.join('\n')
        })
      }
      close()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal opened={workspace !== null} onClose={close} title="Remove workspace">
      <Stack gap="md">
        <Text>
          Remove {workspace?.name} from Mainbus? The repo at {workspace?.repoPath} is never deleted.
        </Text>
        {error && (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>
            Cancel
          </Button>
          <Button color="red" onClick={() => void confirm()} loading={busy}>
            Remove
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
