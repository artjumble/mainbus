import type { BoardTicket } from '../store'

/**
 * Whether a card matches what the person typed in the board's search box. `#12` matches only ticket 12; plain
 * digits match the number or that text anywhere; anything else is a case-insensitive substring of the title, a
 * label or one of the ticket's words.
 */
export function matchesSearch(ticket: BoardTicket, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  if (/^#\d+$/.test(q)) return ticket.number === Number(q.slice(1))
  if (/^\d+$/.test(q) && ticket.number === Number(q)) return true
  return (
    ticket.title.toLowerCase().includes(q) ||
    ticket.labels.some((l) => l.toLowerCase().includes(q)) ||
    ticket.intent.some((i) => i.text.toLowerCase().includes(q))
  )
}
