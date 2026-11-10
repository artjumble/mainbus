import { ActionIcon, Badge, Button, Center, FileButton, Flex, Group, Loader, Stack, Text, Title, UnstyledButton } from '@mantine/core'
import { useState, type ReactElement } from 'react'
import type { NewAttachment, WorkspaceSummary } from '../../../shared/api'
import { IMAGES_PER_MESSAGE, whyNotSendable } from '../../../shared/attachments'
import type { Decision } from '../../../shared/domain'
import { effortLabel } from '../../../shared/models'
import { invoke } from '../api'
import { IMAGE_ACCEPT, MessageImages } from '../attachments/Attachments'
import { readImages } from '../attachments/files'
import { showError } from '../notify'
import { useMainbus } from '../store'
import { Composer } from '../thread/Composer'
import { Thread } from '../thread/Thread'
import { DEFAULT_PANEL_WIDTH } from './panelState'
import { useOrchestratorModel } from './useOrchestratorModel'
import { useOrchestratorThread } from './useOrchestratorThread'
import { WaitingOnYou } from './WaitingOnYou'

/** The aside's width open, and collapsed to its strip. */
export const PANEL_WIDTH = DEFAULT_PANEL_WIDTH
export const STRIP_WIDTH = 44

export const EMPTY_TEXT = "Ask me to draft tickets, or about what's happening on the board."

/**
 * The Fleet line's numbers, of agents across every workspace: working, waiting on you, and idle (open but paused or
 * queued).
 */
export function fleetCounts(workspaces: WorkspaceSummary[]): { working: number; needYou: number; idle: number } {
  const sum = (pick: (w: WorkspaceSummary) => number): number => workspaces.reduce((total, w) => total + pick(w), 0)
  return { working: sum((w) => w.working), needYou: sum((w) => w.waiting), idle: sum((w) => w.idle) }
}

/** The orchestrator's thread has no decision cards of its own: the pending ones are pinned above it. */
const NO_DECISIONS: Decision[] = []

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The orchestrator, docked beside the board and the ticket view: its thread and a message box, or collapsed to a
 * strip with the needs-you count. The thread is loaded and followed even while collapsed.
 */
export function OrchestratorPanel({ open, onOpenChange }: Props): ReactElement {
  const thread = useOrchestratorThread()
  const model = useOrchestratorModel()
  const reveal = useMainbus((s) => s.revealedProposal)
  const prefill = useMainbus((s) => s.orchestratorPrefill)
  const clearPrefill = useMainbus((s) => s.clearOrchestratorPrefill)
  // Across every workspace: the strip is how you notice that one that isn't on screen needs you.
  const needsYou = useMainbus((s) => s.workspaces.reduce((total, w) => total + w.needsYou, 0))
  const workspaceName = useMainbus((s) => s.workspace?.name ?? 'no workspace')
  const workspaces = useMainbus((s) => s.workspaces)
  const focusedId = useMainbus((s) => s.workspace?.id)
  const fleet = fleetCounts(workspaces)
  // The images of the message being written; kept while the panel is collapsed.
  const [images, setImages] = useState<NewAttachment[]>([])

  if (!open) {
    return (
      <UnstyledButton
        h="100%"
        w="100%"
        py="md"
        aria-label={`Open orchestrator (${needsYou} need you)`}
        onClick={() => onOpenChange(true)}
      >
        <Stack align="center" gap="sm" h="100%">
          <Badge color={needsYou > 0 ? 'needs' : 'gray'} variant={needsYou > 0 ? 'filled' : 'light'} circle data-needs-you>
            {needsYou}
          </Badge>
          <Text size="sm" fw={600} c="dimmed" style={{ writingMode: 'vertical-rl' }}>
            Orchestrator
          </Text>
        </Stack>
      </UnstyledButton>
    )
  }

  async function send(text: string, mentions: string[] = []): Promise<void> {
    try {
      const withImages = images.length > 0 ? images : undefined
      await (mentions.length > 0
        ? invoke('orchestrator.send', text, withImages, mentions)
        : withImages
          ? invoke('orchestrator.send', text, withImages)
          : invoke('orchestrator.send', text))
      setImages([])
    } catch (err) {
      showError(err, 'Could not send')
      throw err
    }
  }

  // Pasted, dropped or picked: checked as the engine will, each refused one shown with its reason.
  async function attach(files: File[]): Promise<void> {
    const read = await readImages(files, images.length, whyNotSendable)
    if (read.length > 0) setImages((now) => [...now, ...read].slice(0, IMAGES_PER_MESSAGE))
  }

  async function stop(): Promise<void> {
    try {
      await invoke('orchestrator.stop')
    } catch (err) {
      showError(err, 'Could not stop')
    }
  }

  const working = thread?.status === 'working'
  const full = images.length >= IMAGES_PER_MESSAGE

  return (
    <Flex direction="column" h="100%" mih={0}>
      <Group
        justify="space-between"
        px="md"
        py="xs"
        wrap="nowrap"
        style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
      >
        <Stack gap={0}>
          <Title order={2} size="h5">
            Orchestrator
          </Title>
          <Text size="xs" c="dimmed">
            All workspaces · focused on {workspaceName}
          </Text>
          {model && (
            <Text size="xs" c="dimmed" data-orchestrator-model>
              {`${model.current.label} · ${effortLabel(model.effort)} effort`}
            </Text>
          )}
          {model?.notice && (
            <Text size="xs" c="needs" data-model-notice>
              {model.notice}
            </Text>
          )}
        </Stack>
        <ActionIcon variant="subtle" color="gray" aria-label="Collapse orchestrator panel" onClick={() => onOpenChange(false)}>
          <span aria-hidden>›</span>
        </ActionIcon>
      </Group>
      <Text size="xs" c="dimmed" ta="center" py={6} data-fleet>
        {`Fleet: ${fleet.working} working · ${fleet.needYou} need you · ${fleet.idle} idle`}
      </Text>
      <WaitingOnYou />
      {thread === null ? (
        <Center flex={1}>
          <Loader size="sm" />
        </Center>
      ) : thread.events.length === 0 ? (
        <Center flex={1} p="md">
          <Text size="sm" c="dimmed" ta="center">
            {EMPTY_TEXT}
          </Text>
        </Center>
      ) : (
        <Thread events={thread.events} decisions={NO_DECISIONS} runs={thread.runs} proposals={thread.proposals} edits={thread.edits} reveal={reveal} summariseTools />
      )}
      {/* Always mounted, so a screen reader announces the line when it appears, once, and politely. */}
      <div role="status">
        {working && (
          <Group gap="xs" px="md" py={4} data-working>
            <Loader size={12} type="dots" aria-hidden />
            <Text size="sm" c="dimmed" fs="italic">
              Working…
            </Text>
          </Group>
        )}
      </div>
      <Stack p="sm" pt={4} gap={6}>
        {images.length > 0 && <MessageImages images={images} onRemove={(i) => setImages((now) => now.filter((_, j) => j !== i))} />}
        <Composer
          label="Message the orchestrator"
          placeholder="Ask for status, create tickets, start or stop agents"
          enterSends
          working={working}
          onStop={stop}
          onSend={send}
          mentions={{
            label: 'Workspaces',
            options: workspaces.map((w) => ({ id: w.id, name: w.name, detail: w.repoPath, current: w.id === focusedId }))
          }}
          prefill={prefill}
          onPrefilled={clearPrefill}
          onAttach={(files) => void attach(files)}
          canSendEmpty={images.length > 0}
        />
        {/* On the left, clear of Send: their hit areas would overlap. */}
        <Group gap="xs" wrap="nowrap">
          <FileButton onChange={(files) => void attach(files)} accept={IMAGE_ACCEPT} multiple disabled={full}>
            {(props) => (
              <Button {...props} disabled={full} size="compact-xs" variant="default" style={{ flexShrink: 0 }}>
                Add images
              </Button>
            )}
          </FileButton>
          <Text size="xs" c="dimmed">
            {`or paste or drop them into the box, up to ${IMAGES_PER_MESSAGE}`}
          </Text>
        </Group>
      </Stack>
    </Flex>
  )
}
