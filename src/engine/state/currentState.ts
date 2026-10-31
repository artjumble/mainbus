import type { Decision, Phase, Ticket, TicketState } from '../../shared/domain'
import type { StoredEvent } from '../../shared/events'

export interface StateInput {
  ticket: Ticket
  run: { endReason: 'handoff' | 'stopped' | 'failed' | null; events: StoredEvent[] } | null
  /** Only pending decisions; the caller filters by status. */
  pendingDecisions: Decision[]
  processAlive: boolean
  activePhase: Phase
}

/**
 * Derives a ticket's board column, phase and agent status from its manual column,
 * its latest run, and the decisions still waiting on the user.
 * Precedence: done, handoff, pending decision, failed, stopped, paused, working.
 */
export function currentState(input: StateInput): TicketState {
  const { ticket, run, pendingDecisions, processAlive, activePhase } = input

  if (ticket.manualColumn === 'done') {
    return { column: 'done', phase: 'done', agentStatus: null, summary: null, canContinue: false }
  }
  if (!run) {
    return { column: ticket.manualColumn, phase: 'not_started', agentStatus: null, summary: null, canContinue: false }
  }
  if (run.endReason === 'handoff') {
    return { column: 'review', phase: 'ready_for_review', agentStatus: 'handed_off', summary: null, canContinue: false }
  }
  if (pendingDecisions.length > 0) {
    return {
      column: 'needs_you',
      phase: 'waiting_on_you',
      agentStatus: 'waiting_on_you',
      summary: pendingDecisions[0].question,
      canContinue: false
    }
  }
  if (run.endReason === 'failed') {
    return {
      column: 'needs_you',
      phase: activePhase,
      agentStatus: 'failed',
      summary: failureSummary(run.events),
      canContinue: false
    }
  }
  if (run.endReason === 'stopped') {
    // Stopping puts the ticket back in Ready; the user may then move it to Backlog.
    return { column: ticket.manualColumn, phase: 'not_started', agentStatus: null, summary: null, canContinue: false }
  }
  if (!processAlive) {
    return { column: 'in_progress', phase: activePhase, agentStatus: 'paused', summary: null, canContinue: true }
  }
  return { column: 'in_progress', phase: activePhase, agentStatus: 'working', summary: null, canContinue: false }
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
