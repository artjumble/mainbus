import { Alert, Anchor, Box, Button, Center, Flex, Group, Loader, Stack, Text, Title } from '@mantine/core'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { StartOptions } from '../../../shared/domain'
import { invoke } from '../api'
import { HoldChip } from '../board/HoldChip'
import { StuckChip, StuckEvidence } from '../board/StuckChip'
import { PausedChip, PhaseChip, PrLink } from '../board/TicketCard'
import { showError } from '../notify'
import { useMainbus, type BoardTicket } from '../store'
import { showAgentError } from '../thread/agentError'
import { Composer } from '../thread/Composer'
import { Thread } from '../thread/Thread'
import { useThread } from '../thread/useThread'
import { AdjustStartModal } from './AdjustStartModal'
import { ContextPane } from './ContextPane'
import { HoldMenu } from './HoldMenu'
import { LineupStrip } from './LineupStrip'
import { SkipModal } from './SkipModal'

const HEADER_HEIGHT = 48
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
    <Flex direction="column" h={`calc(100vh - ${HEADER_HEIGHT}px)`}>
      <Stack gap={4} px="md" py="sm" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
        {back}
        <Group gap="sm" align="baseline">
          <Text c="dimmed">#{ticket.number}</Text>
          <Title order={2} size="h3">
            {ticket.title}
          </Title>
          <Text>is</Text>
          <PhaseChip state={ticket.state} />
          <PausedChip state={ticket.state} />
          <HoldChip hold={ticket.hold} />
          <StuckChip stuck={ticket.stuck} />
          {ticket.pr && <PrLink pr={ticket.pr} size="sm" />}
          <Text size="sm" c="dimmed" ml="auto">
            Source: Local
          </Text>
        </Group>
        {ticket.prError !== null && ticket.state.column === 'review' && <PrFailure ticket={ticket} />}
        <StuckEvidence stuck={ticket.stuck} />
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

function TicketBody({ ticket }: { ticket: BoardTicket }): ReactElement {
  const thread = useThread(ticket.id)
  // A move the engine has not finished (a move to Done may remove the worktree): nothing may start meanwhile.
  const moving = useMainbus((s) => ticket.id in s.pendingMoves)
  const [busy, setBusy] = useState(false)
  const [adjusting, setAdjusting] = useState(false)
  // Held in a ref as well: two clicks in the same tick must not both pass the guard.
  const working = useRef(false)
  // True once this screen has started a run that the board has not shown yet, so a retried send does not start again.
  const started = useRef(false)
  const [skipping, setSkipping] = useState(false)
  const proposeReplace = useMainbus((s) => s.proposeReplace)
  const { agentStatus, canContinue, phase, pausedByUser } = ticket.state
  const isDone = phase === 'done'
  const ended = agentStatus === 'failed' || agentStatus === 'handed_off'
  // A ticket whose latest run ended can be started again; a done ticket cannot (it would re-create the removed worktree).
  const canStart = !isDone && ((agentStatus === null && !canContinue) || ended)
  const runOpen =
    canContinue || pausedByUser || agentStatus === 'working' || agentStatus === 'queued' || agentStatus === 'waiting_on_you'

  useEffect(() => {
    started.current = false
  }, [agentStatus, canContinue])

  /** Runs one agent command at a time; resolves false when it failed or another one was in progress. */
  async function guarded(step: () => Promise<void>, title: string): Promise<boolean> {
    if (working.current) return false
    working.current = true
    setBusy(true)
    try {
      await step()
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
    title: string
  ): Promise<void> {
    await guarded(async () => {
      await invoke(command, ticket.id)
      if (command === 'agent.start') started.current = false
    }, title)
  }

  async function send(text: string): Promise<void> {
    // Another command is in progress, or a move that would have to finish before a start: keep the text, say nothing.
    if (working.current || (moving && canStart && !started.current)) throw new Error('busy')
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

  /** Adjust before starting: runs only the ticked roles. Resolves true once started. */
  function startRoles(opts: StartOptions): Promise<boolean> {
    return guarded(async () => {
      await invoke('agent.start', ticket.id, opts)
      started.current = false
    }, 'Could not start')
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

  /** Replace…: opens the replace card in the orchestrator panel, with no stuck episode needed. */
  function replace(): Promise<boolean> {
    return guarded(() => proposeReplace(ticket.id), 'Could not propose a replacement')
  }

  const activeRole = ticket.lineup.find((r) => r.active)
  const composerPlaceholder = ended
    ? 'Message to start a new run'
    : canStart
      ? 'First message (starts the lineup)'
      : activeRole
        ? `Message the ${activeRole.name}`
        : 'Message the agent'

  return (
    <Flex flex={1} mih={0}>
      <Box w={CONTEXT_WIDTH} style={{ flexShrink: 0, overflowY: 'auto', borderRight: '1px solid var(--mantine-color-default-border)' }}>
        <ContextPane ticket={ticket} events={thread?.events ?? []} decisions={thread?.decisions ?? []} />
      </Box>
      <Flex direction="column" flex={1} miw={0}>
        <LineupStrip roles={ticket.lineup} />
        <Group px="md" py="xs" gap="sm" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
          {activeRole && (
            <Text size="sm" fw={600}>
              {activeRole.name}
            </Text>
          )}
          {runOpen && (
            <Button size="compact-sm" variant="default" disabled={busy} onClick={() => void control('agent.stop', 'Could not stop')}>
              Stop
            </Button>
          )}
          {agentStatus === 'working' && (
            <Button size="compact-sm" variant="default" disabled={busy} onClick={() => void control('agent.pause', 'Could not pause')}>
              Pause
            </Button>
          )}
          {pausedByUser && (
            <Button size="compact-sm" disabled={busy} onClick={() => void control('agent.resume', 'Could not resume')}>
              Resume
            </Button>
          )}
          {runOpen && activeRole && (
            <Button size="compact-sm" variant="default" disabled={busy} onClick={() => setSkipping(true)}>
              Skip to next role
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
          {canStart && (
            <Button size="compact-sm" disabled={busy || moving} onClick={() => void control('agent.start', 'Could not start')}>
              {ended ? 'Start again' : 'Start'}
            </Button>
          )}
          {canStart && (
            <Button size="compact-sm" variant="default" disabled={busy || moving} onClick={() => setAdjusting(true)}>
              Adjust before starting
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
        <AdjustStartModal opened={adjusting && canStart} onClose={() => setAdjusting(false)} onStart={startRoles} />
        <SkipModal
          opened={skipping && runOpen && activeRole !== undefined}
          role={activeRole?.name ?? ''}
          next={ticket.skipTo}
          onClose={() => setSkipping(false)}
          onSkip={skip}
        />
        {thread ? (
          <Thread events={thread.events} decisions={thread.decisions} runs={thread.runs} />
        ) : (
          <Center flex={1}>
            <Loader />
          </Center>
        )}
        <Box p="md" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
          {isDone ? (
            <Text size="sm" c="dimmed">
              This ticket is done.
            </Text>
          ) : (
            <Composer onSend={send} placeholder={composerPlaceholder} />
          )}
        </Box>
      </Flex>
    </Flex>
  )
}
