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
  UnstyledButton
} from '@mantine/core'
import { useReducedMotion } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { FolderReadiness, WorkspaceSummary } from '../../../shared/api'
import { addBaseQuestion } from '../../../shared/baseBranch'
import { invoke, openFolder } from '../api'
import { isKeyboardFocus, useExpandOnHover } from '../expandOnHover'
import { errorMessage, showError } from '../notify'
import { ROW_BADGE } from '../rowBadgeStyles'
import { useMainbus } from '../store'
import { BaseBranchStep } from './BaseBranchStep'
import { GitSetup } from './GitSetup'
import classes from './WorkspaceRail.module.css'

/** The rail's layout width: always collapsed to initials, so the board never shifts. */
export const RAIL_WIDTH = 72
/** The width it opens to, over the board. */
export const RAIL_EXPANDED_WIDTH = 200

/** Up to two letters for a narrow rail: the first letters of the first two words, or the name's first two letters. */
export function initials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? name).slice(0, 2)
  return letters.toUpperCase()
}

/** The status line under a workspace's name; the symbol keeps the state from resting on colour alone. */
export function railStatus(w: WorkspaceSummary): string {
  if (w.working > 0) return `• ${w.working} working`
  if (w.needsYou > 0 || w.waiting > 0) return '◆ Waiting on you'
  return '○ Idle'
}

function describe(w: WorkspaceSummary): string {
  // The name and the count come first and unpunctuated, as they read on screen ("repo 1"), so the label contains
  // the button's visible text.
  const named = w.needsYou > 0 ? `${w.name} ${w.needsYou} need you` : w.name
  return w.active ? `${named} · agents working` : named
}

/** The left rail: every open workspace with its activity and needs-you count, a way to add one, and the Mainbus settings. */
export function WorkspaceRail(): ReactElement {
  const workspaces = useMainbus((s) => s.workspaces)
  const focusedId = useMainbus((s) => s.workspace?.id ?? null)
  const focusWorkspace = useMainbus((s) => s.focusWorkspace)
  const openSettings = useMainbus((s) => s.openSettings)
  const openAppSettings = useMainbus((s) => s.openAppSettings)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<WorkspaceSummary | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [hovered, setHovered] = useState(false)
  const [keyboardFocused, setKeyboardFocused] = useState(false)
  const navRef = useRef<HTMLDivElement>(null)
  const reducedMotion = useReducedMotion()
  // The menu and the dialogs render in portals outside the rail, so moving into them must not collapse it.
  const held = menuFor !== null || adding || removing !== null
  const expanded = useExpandOnHover(keyboardFocused || held, hovered)

  // Native listeners, since React carries enter, leave and focus events through portals, which would count the
  // menu and the dialogs as part of the rail. Only keyboard focus expands it: a click leaves focus on the button.
  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const enter = (): void => setHovered(true)
    const leave = (): void => setHovered(false)
    const focusIn = (e: FocusEvent): void =>
      setKeyboardFocused(e.target instanceof Element && isKeyboardFocus(e.target))
    const focusOut = (e: FocusEvent): void => {
      if (!(e.relatedTarget instanceof Node && nav.contains(e.relatedTarget))) setKeyboardFocused(false)
    }
    nav.addEventListener('pointerenter', enter)
    nav.addEventListener('pointerleave', leave)
    nav.addEventListener('focusin', focusIn)
    nav.addEventListener('focusout', focusOut)
    return () => {
      nav.removeEventListener('pointerenter', enter)
      nav.removeEventListener('pointerleave', leave)
      nav.removeEventListener('focusin', focusIn)
      nav.removeEventListener('focusout', focusOut)
    }
  }, [])

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
    // Out of flow over the board: expanding widens the rail without moving anything beside it. The bottom padding
    // leaves room for the Mainbus settings button's 44 px hit area.
    <Stack
      component="nav"
      ref={navRef}
      aria-label="Workspaces"
      data-expanded={expanded}
      gap="xs"
      p={4}
      pt="xs"
      pb="md"
      justify="space-between"
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        zIndex: 1,
        width: expanded ? RAIL_EXPANDED_WIDTH : '100%',
        overflowX: 'hidden',
        background: 'var(--mantine-color-body)',
        borderRight: expanded ? '1px solid var(--mantine-color-default-border)' : undefined,
        boxShadow: expanded ? 'var(--mantine-shadow-md)' : undefined,
        transition: reducedMotion ? 'none' : 'width 150ms ease'
      }}
    >
      <Stack gap={4}>
        {workspaces.map((w) => (
          <Box key={w.id}>
            <Group gap={2} wrap="nowrap" justify="space-between">
              <UnstyledButton
                onClick={() => void focus(w)}
                aria-current={w.id === focusedId ? 'true' : undefined}
                aria-label={describe(w)}
                p={expanded ? 6 : 4}
                style={{
                  flex: 1,
                  minWidth: 0,
                  borderRadius: 'var(--mantine-radius-sm)',
                  background: w.id === focusedId ? 'var(--mantine-color-default-hover)' : undefined
                }}
              >
                <Group gap={expanded ? 6 : 4} wrap="nowrap" justify={expanded ? undefined : 'center'}>
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
                  {/* The button's label already says all of this, so the text stays out of the screen reader's name. */}
                  {expanded ? (
                    <Text size="sm" fw={w.id === focusedId ? 700 : 500} truncate aria-hidden>
                      {w.name}
                    </Text>
                  ) : (
                    <Text
                      size="sm"
                      fw={w.id === focusedId ? 700 : 500}
                      className={classes.initials}
                      data-initials={initials(w.name)}
                      aria-hidden
                    />
                  )}
                  {w.needsYou > 0 && (
                    <>
                      {/* A space (not drawn in a flex row) keeps the visible text "repo 1", as the label has it. */}{' '}
                      <Badge
                        color="needs"
                        variant="filled"
                        circle
                        size={expanded ? 'md' : 'sm'}
                        data-needs-you
                        {...ROW_BADGE}
                        role="img"
                        aria-hidden
                        aria-label={`${w.needsYou} need you`}
                      >
                        {w.needsYou}
                      </Badge>
                    </>
                  )}
                </Group>
              </UnstyledButton>
              {expanded && (
                <Menu
                  position="right-start"
                  withinPortal
                  onOpen={() => setMenuFor(w.id)}
                  onClose={() => setMenuFor(null)}
                >
                  <Menu.Target>
                    <ActionIcon variant="subtle" color="gray" size="sm" aria-label={`Options for ${w.name}`}>
                      <span aria-hidden>⋯</span>
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Label ff="monospace" maw={280} style={{ wordBreak: 'break-all', textTransform: 'none' }}>
                      {w.repoPath}
                    </Menu.Label>
                    <Menu.Item onClick={() => void settings(w)}>Settings</Menu.Item>
                    <Menu.Item color="red" onClick={() => setRemoving(w)}>
                      Remove…
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              )}
            </Group>
            {/* Under the button, not in it: the button's label says all this, and must contain the button's own visible text. */}
            {expanded && (
              <Text size="xs" c="dimmed" pl={20} aria-hidden data-rail-status>
                {railStatus(w)}
              </Text>
            )}
          </Box>
        ))}
      </Stack>
      {/* Apart enough that the two buttons' 44 px hit areas don't overlap. */}
      <Stack gap="md">
        {/* With no workspace yet, the welcome screen offers Add workspace itself. */}
        {workspaces.length > 0 && (
          <Stack gap={6}>
            <Button
              variant="default"
              size="xs"
              fullWidth
              onClick={() => setAdding(true)}
              aria-label="Add workspace"
              styles={{ root: { borderStyle: 'dashed' } }}
            >
              <Text component="span" size="xs" aria-hidden>
                {expanded ? '+ Add workspace' : '+'}
              </Text>
            </Button>
            {expanded && (
              <Text size="xs" c="dimmed">
                Pick a local repo folder to add it.
              </Text>
            )}
          </Stack>
        )}
        {/* One button, collapsed or expanded, so the drawer can give focus back to it whatever the rail did meanwhile. */}
        <Button
          variant="subtle"
          color="gray"
          size="xs"
          fullWidth
          onClick={openAppSettings}
          aria-label="Mainbus settings"
          justify={expanded ? 'flex-start' : 'center'}
        >
          <Text component="span" size="xs" aria-hidden>
            {expanded ? '⚙ Mainbus settings' : '⚙'}
          </Text>
        </Button>
      </Stack>
      <AddWorkspaceModal opened={adding} onClose={() => setAdding(false)} />
      <RemoveWorkspaceModal workspace={removing} onClose={() => setRemoving(null)} />
    </Stack>
  )
}

function AddWorkspaceModal({ opened, onClose }: { opened: boolean; onClose: () => void }): ReactElement {
  const openWorkspace = useMainbus((s) => s.openWorkspace)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notReady, setNotReady] = useState<FolderReadiness | null>(null)
  const [askBase, setAskBase] = useState<FolderReadiness | null>(null)

  function close(): void {
    setNotReady(null)
    setAskBase(null)
    setError(null)
    onClose()
  }

  async function choose(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const folder = await openFolder()
      if (!folder) return
      const readiness = await invoke('workspace.check', folder)
      if (readiness.status === 'ready' && readiness.base && addBaseQuestion(readiness.base) !== 'none') {
        setAskBase(readiness)
      } else if (readiness.status === 'ready') {
        await openWorkspace(folder)
        close()
      } else {
        setNotReady(readiness)
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal opened={opened} onClose={close} title="Add workspace">
      {askBase?.base ? (
        <BaseBranchStep folder={askBase.folder} choice={askBase.base} onDone={close} onCancel={close} />
      ) : notReady ? (
        <GitSetup readiness={notReady} onDone={close} onCancel={close} />
      ) : (
      <Stack gap="md">
        <Text>
          Pick the folder of the project you want to work on. If it isn't a git repository yet, Mainbus can set one up
          for you.
        </Text>
        <Text size="sm" c="dimmed">
          Claude Code can't ask you to trust a folder while Mainbus runs it, so Mainbus treats the folder you pick as
          trusted. Its agents work in their own copy of the project, one folder per ticket, never in your checkout.
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
          <Button onClick={() => void choose()} loading={busy}>
            Choose folder…
          </Button>
        </Group>
      </Stack>
      )}
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
