import { Alert, Anchor, Badge, Box, Button, Center, Flex, Group, Loader, Stack, Text, Title } from '@mantine/core'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { invoke } from '../api'
import { attachToTicket, useImagePaste } from '../attachments/files'
import { asOwnChange } from '../board/ownChanges'
import { HoldChip } from '../board/HoldChip'
import { RunSettingsChip } from '../board/RunSettingsChip'
import { FreshnessChip } from '../board/FreshnessChip'
import { StuckChip, StuckEvidence } from '../board/StuckChip'
import { PausedChip, PhaseChip, PrLink, QueuedChip, SettingUpChip } from '../board/TicketCard'
import { showError } from '../notify'
import { useMainbus, type BoardTicket } from '../store'
import { showAgentError } from '../thread/agentError'
import { Composer } from '../thread/Composer'
import { liveLine } from '../thread/liveLine'
import { Thread } from '../thread/Thread'
import { useThread } from '../thread/useThread'
import { ContextPane } from './ContextPane'
import { HoldMenu } from './HoldMenu'
import { LineupStrip } from './LineupStrip'
import { PromoteModal } from './PromoteModal'
import { PreviousRunView } from './PreviousRunView'
import { RunSettingsModal, runSettingsEditable } from './RunSettingsModal'
import { SkipModal } from './SkipModal'
import { MergeModal } from './MergeModal'
import { UpdateFromMainModal } from './UpdateFromMainModal'
import { StartBlockedModal } from './StartBlockedModal'
import { openBlockers } from '../../../shared/dependencies'

const CONTEXT_WIDTH = 380

/** The split view for one ticket: its context on the left, the live agent thread on the right. */
export function TicketView(): ReactElement {
  const ticketId = useMainbus((s) => s.currentTicketId)
  const ticket = useMainbus((s) => s.tickets.find((t) => t.id === ticketId))
  const workspace = useMainbus((s) => s.workspace)
  const closeTicket = useMainbus((s) => s.closeTicket)

  const back = (
    <Anchor component="button" type="button" size="sm" onClick={closeTicket} style={{ alignSelf: 'flex-start' }}>
      {`← ${workspace?.name ?? 'Workspace'} board`}
    </Anchor>
  )

  if (!ticket) {
    return (
      <Stack p="md" gap="md">
        {back}
        <Text>This ticket is no longer on the board.</Text>
      </Stack>
    )
  }

  return (
    <Flex direction="column" h="100vh">
      <Stack gap={4} px="md" py="sm" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
        <Group gap="sm" align="baseline">
          {back}
          <Text c="dimmed">#{ticket.number}</Text>
          <Title order={2} size="h3">
            {ticket.title}
          </Title>
          <Text>is</Text>
          <PhaseChip state={ticket.state} />
          <PausedChip state={ticket.state} />
          <QueuedChip state={ticket.state} />
          <SettingUpChip state={ticket.state} />
          <HoldChip hold={ticket.hold} />
          <RunSettingsChip ticket={ticket} />
          <StuckChip stuck={ticket.stuck} />
          <FreshnessChip freshness={ticket.freshness} done={ticket.manualColumn === 'done'} />
          {ticket.pr && <PrLink pr={ticket.pr} size="sm" />}
          <Badge variant="outline" color="gray" size="sm" radius="sm" tt="none" ml="auto">
            Source: Local
          </Badge>
        </Group>
        {ticket.state.pausedByLimit && ticket.state.summary && (
          <Text size="sm" c="dimmed">
            {ticket.state.summary}
          </Text>
        )}
        {ticket.reportFileError !== null && ticket.state.column === 'review' && <ReportFileFailure ticket={ticket} />}
        {ticket.prError !== null && ticket.state.column === 'review' && <PrFailure ticket={ticket} />}
        <StuckEvidence stuck={ticket.stuck} />
        {ticket.state.column === 'done' && (
          <Text size="sm" c="dimmed">
            Done tickets are read-only. Move it back to Ready to change it.
          </Text>
        )}
      </Stack>
      <TicketBody key={ticket.id} ticket={ticket} />
    </Flex>
  )
}

/** Why Mainbus couldn't push the branch or open the PR, with a Retry that runs the same steps again. */
function PrFailure({ ticket }: { ticket: BoardTicket }): ReactElement {
  const [retrying, setRetrying] = useState(false)

  async function retry(): Promise<void> {
    setRetrying(true)
    try {
      // A new failure comes back on the ticket, through the board; a refusal comes back here.
      await invoke('ticket.openPr', ticket.id)
    } catch (err) {
      showError(err, "Couldn't open a PR")
    } finally {
      setRetrying(false)
    }
  }

  return (
    <Alert color="needs" variant="light" p="xs" mt={4}>
      <Group gap="sm" wrap="nowrap" justify="space-between">
        <Text size="sm">{`Couldn't open a PR: ${ticket.prError}`}</Text>
        <Button size="compact-sm" variant="default" loading={retrying} onClick={() => void retry()}>
          Retry
        </Button>
      </Group>
    </Alert>
  )
}

/** Why Mainbus couldn't save the report as a file in the repo (the report itself is kept), with a retry. */
function ReportFileFailure({ ticket }: { ticket: BoardTicket }): ReactElement {
  const [saving, setSaving] = useState(false)

  async function retry(): Promise<void> {
    setSaving(true)
    try {
      // A new failure comes back on the ticket, through the board; a refusal comes back here.
      await invoke('ticket.saveReport', ticket.id)
    } catch (err) {
      showError(err, "Couldn't save the report to the repo")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Alert color="needs" variant="light" p="xs" mt={4}>
      <Group gap="sm" wrap="nowrap" justify="space-between">
        <Text size="sm">{`Couldn't save the report to the repo: ${ticket.reportFileError?.replace(/\.$/, '')}. The report is kept on the ticket.`}</Text>
        <Button size="compact-sm" variant="default" loading={saving} onClick={() => void retry()} style={{ flexShrink: 0 }}>
          Save report to repo
        </Button>
      </Group>
    </Alert>
  )
}

function TicketBody({ ticket }: { ticket: BoardTicket }): ReactElement {
  const thread = useThread(ticket.id)
  // A move the engine has not finished (a move to Done may remove the worktree): nothing may start meanwhile.
  const moving = useMainbus((s) => ticket.id in s.pendingMoves)
  const [busy, setBusy] = useState(false)
  // Run setup again has been asked for and the engine has not answered yet; setup can take minutes, so it never holds `busy` (Stop must stay usable).
  const [startingSetup, setStartingSetup] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Held in a ref as well: two clicks in the same tick must not both pass the guard.
  const working = useRef(false)
  // True once this screen has started a run that the board has not shown yet, so a retried send does not start again.
  const started = useRef(false)
  const [skipping, setSkipping] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [merging, setMerging] = useState(false)
  // Start was asked for while a blocker isn't Done: the question is showing.
  const [askingStart, setAskingStart] = useState(false)
  const openBlocked = openBlockers(ticket.blockedBy)
  const [promoting, setPromoting] = useState(false)
  const promoted = useMainbus((s) => s.tickets.some((x) => x.promotedFrom === ticket.id))
  // A replaced run opened on its own, read-only; null for the live thread.
  const [viewing, setViewing] = useState<string | null>(null)
  const proposeReplace = useMainbus((s) => s.proposeReplace)
  const workspace = useMainbus((s) => s.workspace)
  const { agentStatus, canContinue, phase, pausedByUser, pausedByLimit, settingUp } = ticket.state
  const isDone = phase === 'done'
  // An Investigate ticket's report can become a Change ticket, once.
  const canPromote =
    ticket.kind === 'investigate' && !!ticket.report && (ticket.state.column === 'review' || ticket.state.column === 'done') && !promoted
  const ended = agentStatus === 'failed' || agentStatus === 'handed_off'
  // A ticket whose latest run ended can be started again; a done ticket cannot (it would re-create the removed worktree).
  const canStart = !isDone && ((agentStatus === null && !canContinue) || ended)
  const runOpen =
    canContinue || pausedByUser || pausedByLimit === true || agentStatus === 'working' || agentStatus === 'queued' || agentStatus === 'waiting_on_you'

  // "Run setup again": the workspace has a command, the folder exists and no role is working or about to be.
  const canRunSetup =
    !isDone &&
    settingUp !== true &&
    (workspace?.setupCommand ?? '') !== '' &&
    ticket.worktreePath !== null &&
    (agentStatus === null || agentStatus === 'handed_off' || agentStatus === 'failed' || agentStatus === 'paused')

  // "Update from main": the branch lacks commits of the base and no role is working, queued or starting. A paused or waiting run is ended by it.
  const canUpdate =
    !isDone &&
    ticket.kind === 'change' &&
    (ticket.freshness?.behind ?? 0) > 0 &&
    ticket.worktreePath !== null &&
    settingUp !== true &&
    (agentStatus === null || agentStatus === 'handed_off' || agentStatus === 'failed' || agentStatus === 'paused' || agentStatus === 'waiting_on_you')

  // "Merge…": a ticket in Review with a branch.
  const canMerge = !isDone && ticket.state.column === 'review' && ticket.branch !== null && settingUp !== true

  useEffect(() => {
    started.current = false
  }, [agentStatus, canContinue])

  function runSetup(): void {
    setStartingSetup(true)
    // The result lands in the thread; only a refusal comes back here.
    invoke('ticket.runSetup', ticket.id)
      .catch((err: unknown) => showAgentError(err, 'Could not run setup'))
      .finally(() => setStartingSetup(false))
  }

  /** Runs one agent command at a time; resolves false when it failed or another one was in progress. */
  async function guarded(step: () => Promise<void>, title: string): Promise<boolean> {
    if (working.current) return false
    working.current = true
    setBusy(true)
    try {
      await asOwnChange(ticket.id, step)
      return true
    } catch (err) {
      showAgentError(err, title)
      return false
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  async function control(
    command: 'agent.start' | 'agent.stop' | 'agent.continue' | 'agent.pause' | 'agent.resume',
    title: string,
    startAnyway = false
  ): Promise<void> {
    await guarded(async () => {
      if (command === 'agent.start' && startAnyway) await invoke(command, ticket.id, { startAnyway: true })
      else await invoke(command, ticket.id)
      if (command === 'agent.start') started.current = false
    }, title)
  }

  /** Start, Start again and the empty panel's Start: a ticket with an open blocker asks first. */
  function start(): void {
    if (openBlocked.length > 0) setAskingStart(true)
    else void control('agent.start', 'Could not start')
  }

  async function send(text: string): Promise<void> {
    // Another command is in progress, or a move that would have to finish before a start: keep the text, say nothing.
    if (working.current || (moving && canStart && !started.current)) throw new Error('busy')
    // A blocked ticket asks before it starts; the text stays in the box, and sending again follows once the run has started.
    if (canStart && !started.current && openBlocked.length > 0) {
      setAskingStart(true)
      throw new Error('busy')
    }
    const delivered = await guarded(async () => {
      // A new run starts first, then gets the message.
      if (canStart && !started.current) {
        await invoke('agent.start', ticket.id)
        started.current = true
      }
      await invoke('agent.send', ticket.id, text)
      started.current = false
    }, 'Could not send your message')
    if (!delivered) throw new Error('not sent')
  }

  /** Holds the ticket until a date (ISO) or with no date. Resolves true once it is held. */
  function hold(until: string | null): Promise<boolean> {
    return guarded(async () => {
      await invoke('ticket.hold', ticket.id, until === null ? {} : { until })
    }, 'Could not hold')
  }

  /** Skip to next role, once confirmed. Resolves true once skipped. */
  function skip(): Promise<boolean> {
    return guarded(() => invoke('agent.skip', ticket.id), 'Could not skip')
  }

  function updateFromMain(): Promise<boolean> {
    return guarded(() => invoke('ticket.updateFromMain', ticket.id), 'Could not update from main')
  }

  /** Replace…: opens the replace card in the orchestrator panel, with no stuck episode needed. */
  function replace(): Promise<boolean> {
    return guarded(() => proposeReplace(ticket.id), 'Could not propose a replacement')
  }

  /** Attaches images to the ticket; a working agent is told by Mainbus. */
  const attach = useCallback(
    (files: File[]) => {
      // A Done ticket is read-only: a pasted image is left alone.
      if (!isDone) void attachToTicket(ticket.id, files, ticket.attachments.length)
    },
    [ticket.id, ticket.attachments.length, isDone]
  )

  useImagePaste(attach)

  /** Opens a replaced run's thread; any other run is the live one, so the link goes back to it. */
  const viewRun = useCallback(
    (runId: string) => setViewing(thread?.events.some((e) => e.runId === runId && e.event.kind === 'replaced') ? runId : null),
    [thread]
  )

  const activeRole = ticket.lineup.find((r) => r.active)
  // No run has happened: the thread is replaced by the panel that offers Start (so the controls row doesn't).
  const emptyPanel = thread !== null && thread.events.length === 0 && canStart && !ended
  const composerLabel = ended
    ? 'Message to start a new run'
    : canStart
      ? 'First message (starts the lineup)'
      : activeRole
        ? `Message the ${activeRole.name}`
        : 'Message the agent'
  const composerPlaceholder = canStart && !ended ? 'Optional instructions for the lineup' : 'Steer it, answer a question, add context'

  return (
    <Flex flex={1} mih={0}>
      <Box w={CONTEXT_WIDTH} style={{ flexShrink: 0, overflowY: 'auto', borderRight: '1px solid var(--mantine-color-default-border)' }}>
        <ContextPane ticket={ticket} events={thread?.events ?? []} decisions={thread?.decisions ?? []} runs={thread?.runs} onViewRun={viewRun} />
      </Box>
      {viewing !== null && thread ? (
        <PreviousRunView runId={viewing} thread={thread} onBack={() => setViewing(null)} />
      ) : (
        <Flex direction="column" flex={1} miw={0}>
          <LineupStrip roles={ticket.lineup} />
          {/* When the buttons wrap, rows 18 px apart keep each button's 44 px hit area clear of the next row's. */}
          <Group
            px="md"
            py="xs"
            gap="sm"
            justify="space-between"
            style={{ rowGap: 18, borderBottom: '1px solid var(--mantine-color-default-border)' }}
          >
            {activeRole ? (
              <Text size="sm" c="dimmed">
                {`Controls apply to the ${activeRole.name}`}
              </Text>
            ) : (
              <span />
            )}
            <Group gap="sm" style={{ rowGap: 18 }}>
              {agentStatus === 'working' && (
                <Button size="compact-sm" variant="default" disabled={busy} onClick={() => void control('agent.pause', 'Could not pause')}>
                  Pause
                </Button>
              )}
              {(pausedByUser || pausedByLimit) && (
                <Button size="compact-sm" disabled={busy} onClick={() => void control('agent.resume', 'Could not resume')}>
                  Resume
                </Button>
              )}
              {(runOpen || settingUp === true) && (
                <Button size="compact-sm" variant="default" disabled={busy} onClick={() => void control('agent.stop', 'Could not stop')}>
                  Stop
                </Button>
              )}
              {canRunSetup && (
                <Button size="compact-sm" variant="default" disabled={busy || moving || startingSetup} onClick={runSetup}>
                  Run setup again
                </Button>
              )}
              {canUpdate && (
                <Button size="compact-sm" variant="default" disabled={busy || moving || startingSetup} onClick={() => setUpdating(true)}>
                  {`Update from ${ticket.freshness?.baseBranch ?? 'main'}`}
                </Button>
              )}
              {canMerge && (
                <Button size="compact-sm" disabled={busy || moving} onClick={() => setMerging(true)}>
                  Merge…
                </Button>
              )}
              {runOpen && activeRole && (
                <Button size="compact-sm" variant="default" disabled={busy} onClick={() => setSkipping(true)}>
                  {`Skip to ${ticket.skipTo ?? 'next role'}`}
                </Button>
              )}
              {runOpen && activeRole && (
                <Button size="compact-sm" variant="default" disabled={busy} onClick={() => void replace()}>
                  Replace…
                </Button>
              )}
              {canContinue && (
                <Button size="compact-sm" disabled={busy} onClick={() => void control('agent.continue', 'Could not continue')}>
                  Continue
                </Button>
              )}
              {canStart && thread !== null && !emptyPanel && (
                <Button size="compact-sm" disabled={busy || moving} onClick={start}>
                  {ended ? 'Start again' : 'Start'}
                </Button>
              )}
              {thread !== null && !emptyPanel && (
                <Button size="compact-sm" variant="default" disabled={moving} onClick={() => setSettingsOpen(true)}>
                  Run settings…
                </Button>
              )}
              {canPromote && (
                <Button size="compact-sm" variant="default" disabled={busy} onClick={() => setPromoting(true)}>
                  Promote
                </Button>
              )}
              {!isDone && <HoldMenu disabled={busy} onHold={hold} />}
              {ticket.hold && (
                <Button
                  size="compact-sm"
                  variant="default"
                  disabled={busy}
                  onClick={() => void guarded(() => invoke('ticket.unhold', ticket.id), 'Could not unhold')}
                >
                  Unhold
                </Button>
              )}
            </Group>
          </Group>
          <RunSettingsModal
            opened={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            ticket={ticket}
            editable={runSettingsEditable(ticket.state) && !busy && !isDone}
          />
          <PromoteModal opened={promoting && canPromote} ticketId={ticket.id} onClose={() => setPromoting(false)} />
          <StartBlockedModal
            opened={askingStart && canStart}
            open={openBlocked}
            onClose={() => setAskingStart(false)}
            onStart={() => {
              setAskingStart(false)
              void control('agent.start', 'Could not start', true)
            }}
          />
          <MergeModal opened={merging && canMerge} ticket={ticket} onClose={() => setMerging(false)} />
          <UpdateFromMainModal
            opened={updating && canUpdate}
            base={ticket.freshness?.baseBranch ?? 'main'}
            behind={ticket.freshness?.behind ?? 0}
            openRole={runOpen ? (activeRole?.name ?? 'role') : null}
            onClose={() => setUpdating(false)}
            onUpdate={updateFromMain}
          />
          <SkipModal
            opened={skipping && runOpen && activeRole !== undefined}
            role={activeRole?.name ?? ''}
            next={ticket.skipTo}
            onClose={() => setSkipping(false)}
            onSkip={skip}
          />
          {emptyPanel ? (
            <NobodyWorking
              workspaceName={workspace?.name ?? 'workspace'}
              roles={ticket.lineup.map((r) => r.name)}
              busy={busy || moving}
              onStart={start}
              onRunSettings={() => setSettingsOpen(true)}
            />
          ) : thread ? (
            <Thread events={thread.events} decisions={thread.decisions} runs={thread.runs} onViewRun={viewRun} />
          ) : (
            <Center flex={1}>
              <Loader />
            </Center>
          )}
          {/* Always mounted, so a screen reader announces the line when it appears, politely. */}
          <div role="status">
            {agentStatus === 'working' && activeRole && thread && (
              <Group gap="xs" px="md" py={4} data-live-line>
                <Loader size={12} type="dots" aria-hidden />
                <Text size="sm" c="dimmed" fs="italic">
                  {liveLine(thread.events, activeRole.name, ticket.worktreePath)}
                </Text>
              </Group>
            )}
          </div>
          <Box p="md" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
            {isDone ? (
              <Text size="sm" c="dimmed">
                This ticket is done.
              </Text>
            ) : (
              <Composer
                onSend={send}
                onAttach={attach}
                label={composerLabel}
                placeholder={composerPlaceholder}
                sendLabel={canStart && !ended ? 'Send and start' : 'Send'}
              />
            )}
          </Box>
        </Flex>
      )}
    </Flex>
  )
}

/** In place of an empty thread: nobody has worked this ticket yet, and how to start. */
function NobodyWorking({
  workspaceName,
  roles,
  busy,
  onStart,
  onRunSettings
}: {
  workspaceName: string
  roles: string[]
  busy: boolean
  onStart: () => void
  onRunSettings: () => void
}): ReactElement {
  return (
    // mih 0 and its own scrolling, so a short window scrolls this panel and the composer stays on screen.
    <Center flex={1} mih={0} p="md" data-nobody-working style={{ overflowY: 'auto' }}>
      <Stack align="center" gap="sm" maw={460} ta="center">
        <Title order={3} size="h4">
          Nobody is working on this yet
        </Title>
        <Text c="dimmed">
          {`Starting runs the ${workspaceName} lineup: ${roles.join(' → ')}. Change which roles run, and their models, in Run settings.`}
        </Text>
        <Group gap="sm" justify="center">
          <Button disabled={busy} onClick={onStart}>
            Start
          </Button>
          <Button variant="default" disabled={busy} onClick={onRunSettings}>
            Run settings…
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          Past runs on this ticket appear in the activity timeline.
        </Text>
      </Stack>
    </Center>
  )
}
