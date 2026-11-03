import type { BoardTicket } from '../../shared/api'
import type { Column } from '../../shared/domain'

/** What the tray shows: how many agents work, how many tickets need the user, and how many agents are open at all. */
export interface Activity {
  working: number
  needsYou: number
  /** Agents that are working, queued or waiting on the user: closing the window must not stop these. */
  openAgents: number
}

const OPEN_STATUSES = new Set(['working', 'queued', 'waiting_on_you'])

export function countActivity(boards: BoardTicket[][]): Activity {
  const a: Activity = { working: 0, needsYou: 0, openAgents: 0 }
  for (const ticket of boards.flat()) {
    const { agentStatus, column } = ticket.state
    if (agentStatus === 'working') a.working++
    if (column === 'needs_you') a.needsYou++
    if (agentStatus && OPEN_STATUSES.has(agentStatus)) a.openAgents++
  }
  return a
}

/** A ticket that just reached Needs you or Review. */
export interface Arrival {
  workspaceId: string
  ticketId: string
  number: number
  title: string
  column: 'needs_you' | 'review'
  summary: string | null
}

export type ColumnSnapshot = Map<string, Column>

export function snapshotOf(tickets: BoardTicket[]): ColumnSnapshot {
  return new Map(tickets.map((t) => [t.id, t.state.column]))
}

/**
 * The tickets that moved into Needs you or Review since `prev`. The first snapshot (`prev` null) only seeds, so
 * nothing announces at launch; a ticket that was in the column already is not an arrival.
 */
export function arrivals(prev: ColumnSnapshot | null, tickets: BoardTicket[]): Arrival[] {
  if (!prev) return []
  const out: Arrival[] = []
  for (const t of tickets) {
    const column = t.state.column
    if (column !== 'needs_you' && column !== 'review') continue
    if (prev.get(t.id) === column) continue
    out.push({ workspaceId: t.workspaceId, ticketId: t.id, number: t.number, title: t.title, column, summary: t.state.summary })
  }
  return out
}
