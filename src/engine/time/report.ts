import { ticketTime, workspaceTimeReport, type TicketTime, type WorkspaceTimeReport } from '../../shared/timeBreakdown'
import type { Repos } from '../store'

export type TimeRepos = Pick<Repos, 'runs' | 'decisions' | 'tickets'>

export interface TimeReportRange {
  last?: number
  since?: string
  until?: string
}

/** The most tickets a report covers. */
export const TIME_REPORT_MAX = 50
export const TIME_REPORT_DEFAULT = 10

/** Where one ticket's time went, from its stored events and decisions. Read-only. */
export async function ticketTimeFor(repos: TimeRepos, ticketId: string, now = Date.now()): Promise<TicketTime> {
  const runs = await repos.runs.listForTicket(ticketId)
  const events = (await Promise.all(runs.map((run) => repos.runs.events(run.id)))).flat()
  const ticketRunIds = [...new Set(runs.map((r) => r.ticketRunId))]
  const ticketRuns = await Promise.all(ticketRunIds.map((id) => repos.runs.ticketRun(id)))
  return ticketTime({ runs, events, decisions: await repos.decisions.forTicket(ticketId), ticketRuns, now })
}

/** The time report over the workspace's tickets that reached Review: the newest `last` (10 by default, at most 50), or a day range. */
export async function workspaceTimeFor(repos: TimeRepos, workspaceId: string, range: TimeReportRange = {}, now = Date.now()): Promise<WorkspaceTimeReport> {
  const dated = range.since !== undefined || range.until !== undefined
  const reached = await repos.runs.reachedReview(
    workspaceId,
    dated ? { ...(range.since ? { since: range.since } : {}), ...(range.until ? { until: range.until } : {}) } : { limit: Math.min(TIME_REPORT_MAX, Math.max(1, Math.floor(range.last ?? TIME_REPORT_DEFAULT))) }
  )
  const timed = []
  for (const { ticketId } of dated ? reached.slice(0, TIME_REPORT_MAX) : reached) {
    const ticket = await repos.tickets.get(ticketId)
    if (!ticket) continue
    timed.push({ ticketId, number: ticket.number, title: ticket.title, time: await ticketTimeFor(repos, ticketId, now) })
  }
  return workspaceTimeReport(timed)
}
