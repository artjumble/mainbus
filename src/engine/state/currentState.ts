import type { Decision, Phase, Ticket, TicketState } from '../../shared/domain'
import type { StoredEvent } from '../../shared/events'
import type { EndReason } from '../store/runs'

export interface StateInput {
  ticket: Ticket
  /**
   * A handed-back run is never the latest (the earlier role's run starts before it ends); if it were, the
   * ticket would show as paused mid-lineup.
   */
  run: { endReason: EndReason | null; events: StoredEvent[] } | null
  /** Only pending decisions; the caller filters by status. */
  pendingDecisions: Decision[]
  /** Only deferred decisions (Later…); defaults to none. */
  deferredDecisions?: Decision[]
  processAlive: boolean
  /** The run is in the queue for a free agent slot, at this place (1 first); null or left out when it is not queued. */
  queuePosition?: number | null
  /** The usage limit paused the run (it is not queued or alive); `reason` is what the card says. */
  limitPaused?: { reason: string } | null
  activePhase: Phase
}

/**
 * Derives a ticket's board column, phase and agent status from its manual column,
 * its latest run, and the decisions still waiting on the user.
 * Precedence: done, handoff, pending decision, failed, stopped, deferred decision, paused by the user, queued, paused by the usage limit, paused, working.
 */
export function currentState(input: StateInput): TicketState {
  const { ticket, run, pendingDecisions, processAlive, activePhase } = input
  const deferredDecisions = input.deferredDecisions ?? []
  const none = { summary: null, canContinue: false, pausedByUser: false, deferredUntil: null }

  if (ticket.manualColumn === 'done') {
    return { ...none, column: 'done', phase: 'done', agentStatus: null }
  }
  if (!run) {
    return { ...none, column: ticket.manualColumn, phase: 'not_started', agentStatus: null }
  }
  if (run.endReason === 'handoff') {
    return { ...none, column: 'review', phase: 'ready_for_review', agentStatus: 'handed_off' }
  }
  if (pendingDecisions.length > 0) {
    return {
      ...none,
      column: 'needs_you',
      phase: 'waiting_on_you',
      agentStatus: 'waiting_on_you',
      summary: pendingDecisions[0].question
    }
  }
  if (run.endReason === 'failed') {
    return { ...none, column: 'needs_you', phase: activePhase, agentStatus: 'failed', summary: failureSummary(run.events) }
  }
  if (run.endReason === 'stopped') {
    // Stopping puts the ticket back in Ready; the user may then move it to Backlog.
    return { ...none, column: ticket.manualColumn, phase: 'not_started', agentStatus: null }
  }
  if (deferredDecisions.length > 0) {
    // The agent stays waiting on the user, whether or not its process is alive; the ticket just isn't asking for them now.
    const dates = deferredDecisions.map((d) => d.deferredUntil).filter((d) => d !== null)
    return {
      ...none,
      column: 'in_progress',
      phase: 'waiting_on_you',
      agentStatus: 'waiting_on_you',
      summary: deferredDecisions[0].question,
      deferredUntil: dates.sort()[0] ?? null
    }
  }
  if (run.endReason === null && pausedByUser(run.events)) {
    // Paused at once, even while the process is still going down; only Resume continues it.
    return { ...none, column: 'in_progress', phase: activePhase, agentStatus: 'paused', pausedByUser: true }
  }
  if (run.endReason === null && !processAlive && input.queuePosition != null) {
    // Waiting for a free slot: the ticket stays in progress with its phase unchanged.
    return { ...none, column: 'in_progress', phase: activePhase, agentStatus: 'queued', queuePosition: input.queuePosition }
  }
  if (run.endReason === null && !processAlive && input.limitPaused) {
    // Mainbus resumes it when the limit resets, or the user's Resume does it early; Continue does not.
    return { ...none, column: 'in_progress', phase: activePhase, agentStatus: 'paused', pausedByLimit: true, summary: input.limitPaused.reason }
  }
  if (!processAlive || run.endReason === 'handed_back') {
    return { ...none, column: 'in_progress', phase: activePhase, agentStatus: 'paused', canContinue: true }
  }
  return { ...none, column: 'in_progress', phase: activePhase, agentStatus: 'working' }
}

/** True when the user paused the run and nothing has resumed it since. */
export function pausedByUser(events: StoredEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const kind = events[i].event.kind
    if (kind === 'paused') return true
    if (kind === 'resumed') return false
  }
  return false
}

/** The last error event's message, else the last failed turn's error, else nothing. */
function failureSummary(events: StoredEvent[]): string {
  const message = lastErrorMessage(events)
  return message ? `Failed: ${message}` : 'Failed'
}

function lastErrorMessage(events: StoredEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i].event
    if (event.kind === 'error') return event.message
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i].event
    if (event.kind === 'turn_end' && !event.ok) return event.error
  }
  return undefined
}
