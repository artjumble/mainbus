import type { BoardTicket } from '../../shared/api'
import type { AgentStatus, Column } from '../../shared/domain'

/** A board ticket with only what the tray reads; for tests. */
export function ticket(
  id: string,
  column: Column,
  agentStatus: AgentStatus | null = null,
  extra: { workspaceId?: string; number?: number; title?: string; summary?: string | null } = {}
): BoardTicket {
  return {
    id,
    workspaceId: extra.workspaceId ?? 'w1',
    number: extra.number ?? Number(id.replace(/\D/g, '') || 1),
    title: extra.title ?? `Ticket ${id}`,
    state: { column, agentStatus, summary: extra.summary ?? null }
  } as unknown as BoardTicket
}
