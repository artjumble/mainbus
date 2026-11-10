import { Anchor, Box, Button, Collapse, Group, Paper, Stack, Text, UnstyledButton } from '@mantine/core'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { Decision } from '../../../shared/domain'
import { shortDay } from '../../../shared/hold'
import { invoke } from '../api'
import { phaseLabel } from '../board/TicketCard'
import { asOwnChange } from '../board/ownChanges'
import { useMainbus, type BoardTicket } from '../store'
import { QuestionForm } from '../thread/DecisionCard'
import { showAgentError } from '../thread/agentError'
import { PermissionChoices } from '../thread/PermissionCard'
import { PermissionAsk } from '../thread/PermissionAsk'

/** A permission command in the panel is capped at this many lines before Show all (the thread allows more). */
const PANEL_MAX_LINES = 6

interface Waiting {
  ticket: BoardTicket
  decision: Decision
}

/** Every pending decision on the board, oldest first. */
function waitingOn(tickets: BoardTicket[]): Waiting[] {
  return tickets
    .flatMap((ticket) => ticket.pendingDecisions.map((decision) => ({ ticket, decision })))
    .sort((a, b) => a.decision.createdAt.localeCompare(b.decision.createdAt))
}

/** Every deferred decision on the board, the soonest to come back first. */
function deferredOn(tickets: BoardTicket[]): Waiting[] {
  return tickets
    .flatMap((ticket) => ticket.deferredDecisions.map((decision) => ({ ticket, decision })))
    .sort((a, b) => (a.decision.deferredUntil ?? '').localeCompare(b.decision.deferredUntil ?? ''))
}

function Controls({ decision, onAnswered }: { decision: Decision; onAnswered?: (option?: string) => void }): ReactElement {
  return decision.kind === 'permission' ? (
    <PermissionChoices decision={decision} via="orchestrator" onAnswered={onAnswered} />
  ) : (
    <QuestionForm decision={decision} via="orchestrator" onAnswered={onAnswered} />
  )
}

/** A decision answered from the panel, kept for this session so the panel can say where the ticket went. */
interface Receipt {
  id: string
  ticketId: string
  title: string
  option: string
}

function TicketLine({ ticket, openTicket }: { ticket: BoardTicket; openTicket: (id: string) => void }): ReactElement {
  const role = ticket.lineup.find((r) => r.active)?.name
  return (
    <Text size="xs" c="dimmed">
      <Anchor component="button" type="button" size="xs" onClick={() => openTicket(ticket.id)}>
        {`#${ticket.number} ${ticket.title}`}
      </Anchor>
      {role && ` · ${role}`}
    </Text>
  )
}

async function bringBack(decision: Decision): Promise<void> {
  try {
    await asOwnChange(decision.ticketId, () => invoke('decision.bringBack', decision.id))
  } catch (err) {
    showAgentError(err, 'Could not bring this back')
  }
}

/**
 * The orchestrator's decision cards, pinned above its thread: each pending decision in the workspace with its
 * ticket, the asking role and the thread card's own answer controls, and under them a collapsed Deferred group
 * of the ones the user put off with Later…. It follows the board, so a decision answered anywhere leaves it;
 * with none pending or deferred it is not shown.
 */
export function WaitingOnYou(): ReactElement | null {
  const tickets = useMainbus((s) => s.tickets)
  const openTicket = useMainbus((s) => s.openTicket)
  const workspaceName = useMainbus((s) => s.workspace?.name ?? '')
  const [showDeferred, setShowDeferred] = useState(false)
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const waiting = useMemo(() => waitingOn(tickets), [tickets])
  const deferred = useMemo(() => deferredOn(tickets), [tickets])
  const boxRef = useRef<HTMLDivElement>(null)
  const seen = useRef<Set<string> | null>(null)
  const lastTouched = useRef(0)
  const [newId, setNewId] = useState<string | null>(null)

  const reveal = (id: string) => {
    const card = boxRef.current?.querySelector(`[data-decision-id="${id}"]`)
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    card?.scrollIntoView?.({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
  }

  // A decision that arrives after the panel is up is scrolled into view, unless the user is working in the group:
  // then a pill offers it. Focus never moves.
  useEffect(() => {
    const ids = new Set(waiting.map((w) => w.decision.id))
    const before = seen.current
    seen.current = ids
    setNewId((n) => (n && ids.has(n) ? n : null))
    if (!before) return
    const arrived = waiting.filter((w) => !before.has(w.decision.id)).at(-1)
    if (!arrived) return
    const box = boxRef.current
    const busy = !!box && (box.contains(document.activeElement) || Date.now() - lastTouched.current < 4000)
    if (busy) setNewId(arrived.decision.id)
    else reveal(arrived.decision.id)
  }, [waiting])
  if (waiting.length === 0 && deferred.length === 0 && receipts.length === 0) return null

  const arrivedTicket = newId ? waiting.find((w) => w.decision.id === newId)?.ticket : undefined

  // A put-off decision calls this with no option; only an answer leaves a receipt.
  const answered = (ticket: BoardTicket, decision: Decision) => (option?: string) => {
    if (option === undefined) return
    setReceipts((rs) => [...rs, { id: decision.id, ticketId: ticket.id, title: ticket.title, option }].slice(-3))
  }

  return (
    <Box
      ref={boxRef}
      px="sm"
      py="xs"
      mah="45%"
      data-waiting-box
      onWheel={() => (lastTouched.current = Date.now())}
      onTouchMove={() => (lastTouched.current = Date.now())}
      style={{ overflowY: 'auto', flexShrink: 0, borderBottom: '1px solid var(--mantine-color-default-border)', position: 'relative' }}
    >
      {arrivedTicket && (
        <Button
          size="compact-xs"
          radius="xl"
          style={{ position: 'sticky', top: 0, zIndex: 2, display: 'block', margin: '0 auto 6px' }}
          onClick={() => {
            if (newId) reveal(newId)
            setNewId(null)
          }}
        >
          {`New: #${arrivedTicket.number} is waiting on you ↓`}
        </Button>
      )}
      {waiting.length > 0 && (
        <Box role="region" aria-label="Waiting on you">
          <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={6}>
            Waiting on you ({waiting.length})
          </Text>
          <Stack gap="xs">
            {waiting.map(({ ticket, decision }) => (
              <Paper
                key={decision.id}
                withBorder
                p="sm"
                radius="md"
                data-event="waiting-decision"
                data-decision-id={decision.id}
                bd="1px solid var(--mantine-color-needs-6)"
              >
                <Stack gap="xs">
                  <Text size="xs" fw={700} c="needs.7">
                    {`◆ ${ticket.title}${workspaceName ? ` · ${workspaceName}` : ''}`}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {`#${ticket.number}${ticket.lineup.find((r) => r.active)?.name ? ` · ${ticket.lineup.find((r) => r.active)!.name}` : ''}`}
                  </Text>
                  <PermissionAsk decision={decision} maxLines={PANEL_MAX_LINES} />
                  {/* Sticky, so the answer buttons stay reachable when the card is taller than the group's box. */}
                  <Box
                    data-decision-actions
                    style={{ position: 'sticky', bottom: 0, zIndex: 1, background: 'var(--mantine-color-body)' }}
                  >
                    <Controls decision={decision} onAnswered={answered(ticket, decision)} />
                  </Box>
                  <Button variant="subtle" size="compact-sm" w="fit-content" mt={10} onClick={() => openTicket(ticket.id)}>
                    Open ticket for full context
                  </Button>
                </Stack>
              </Paper>
            ))}
          </Stack>
        </Box>
      )}
      {receipts.length > 0 && (
        <Stack gap={4} mt={waiting.length > 0 ? 'xs' : 0} mb={deferred.length > 0 ? 'xs' : 0} role="status">
          {receipts.map((r) => {
            // The ticket's live phase: where the answer took it.
            const phase = tickets.find((t) => t.id === r.ticketId)?.state.phase
            return (
              <Text key={r.id} size="sm" data-receipt>
                {`✓ Answered: ${r.option}. ${r.title}${phase ? ` is back in ${phaseLabel(phase)}.` : ''}`}
              </Text>
            )
          })}
        </Stack>
      )}
      {deferred.length > 0 && (
        <Box role="region" aria-label="Deferred" mt={waiting.length > 0 && receipts.length === 0 ? 'xs' : 0}>
          <UnstyledButton
            aria-expanded={showDeferred}
            onClick={() => setShowDeferred((o) => !o)}
            style={{ fontSize: 'var(--mantine-font-size-xs)', fontWeight: 700, textTransform: 'uppercase', color: 'var(--mantine-color-dimmed)' }}
          >
            <span aria-hidden>{showDeferred ? '▾' : '▸'}</span> {`Deferred (${deferred.length})`}
          </UnstyledButton>
          <Collapse expanded={showDeferred}>
            <Stack gap="xs" mt={6}>
              {deferred.map(({ ticket, decision }) => (
                <Paper key={decision.id} withBorder p="sm" radius="md" data-event="deferred-decision">
                  <Stack gap="xs">
                    <TicketLine ticket={ticket} openTicket={openTicket} />
                    <PermissionAsk decision={decision} />
                    <Group justify="space-between" gap="xs">
                      <Text size="xs" c="dimmed">
                        {decision.deferredUntil ? `Until ${shortDay(decision.deferredUntil, new Date())}` : 'Deferred'}
                      </Text>
                      <Button size="compact-xs" variant="default" onClick={() => void bringBack(decision)}>
                        Bring back now
                      </Button>
                    </Group>
                    <Controls decision={decision} />
                  </Stack>
                </Paper>
              ))}
            </Stack>
          </Collapse>
        </Box>
      )}
    </Box>
  )
}
