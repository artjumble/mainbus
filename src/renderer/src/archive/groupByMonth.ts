import type { ArchivedTicket } from '../../../shared/domain'

export interface MonthGroup {
  /** "2026-11" in the viewer's time zone: what makes two tickets the same month. */
  key: string
  /** "November 2026". */
  heading: string
  tickets: ArchivedTicket[]
}

/**
 * Splits tickets into runs of the same month of their archive date, in the order given (newest first), so a month
 * is one heading. The month is the viewer's own: a ticket archived at midnight UTC belongs to where they are.
 */
export function groupByMonth(tickets: ArchivedTicket[], locale?: string): MonthGroup[] {
  const groups: MonthGroup[] = []
  for (const t of tickets) {
    const at = new Date(t.archivedAt)
    const key = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`
    const last = groups[groups.length - 1]
    if (last?.key === key) last.tickets.push(t)
    else groups.push({ key, heading: at.toLocaleDateString(locale, { month: 'long', year: 'numeric' }), tickets: [t] })
  }
  return groups
}
