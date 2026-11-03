// How the queue for a free agent slot is worded, in the board, the ticket view and the orchestrator's tools.

/** 1 → "1st", 2 → "2nd", 11 → "11th", 22 → "22nd". */
export function ordinal(n: number): string {
  const lastTwo = n % 100
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`
  const suffix = ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return `${n}${suffix}`
}

/** "Queued · 2nd", or "Queued" when the place is not known. */
export function queuedLabel(position: number | undefined): string {
  return position === undefined ? 'Queued' : `Queued · ${ordinal(position)}`
}
