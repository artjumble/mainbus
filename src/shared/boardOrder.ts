// The order of tickets on the board, shared by the engine and the renderer: Backlog and Ready are ordered by the
// user (a stored rank, smaller is higher); the other columns stay in ticket-number order.
import type { Column } from './domain'

export const BOARD_COLUMNS: readonly Column[] = ['backlog', 'ready', 'in_progress', 'needs_you', 'review', 'done']

/** Columns whose order the user sets. */
export const RANKED_COLUMNS: readonly Column[] = ['backlog', 'ready']

export function isRanked(column: Column): column is 'backlog' | 'ready' {
  return column === 'backlog' || column === 'ready'
}

type Ranked = { rank: number; number: number }

/** Rank first, then number; a missing rank (NaN) falls back to number. */
export function compareRank(a: Ranked, b: Ranked): number {
  return a.rank - b.rank || a.number - b.number
}

/** The tickets grouped by column in the board's order; Backlog and Ready by rank, the rest by number. */
export function inBoardOrder<T extends Ranked>(tickets: T[], columnOf: (t: T) => Column): T[] {
  const out: T[] = []
  for (const column of BOARD_COLUMNS) {
    const inColumn = tickets.filter((t) => columnOf(t) === column)
    inColumn.sort(isRanked(column) ? compareRank : (a, b) => a.number - b.number)
    out.push(...inColumn)
  }
  return out
}

export interface Placement {
  /** The moving ticket's new rank, or 'bottom' for the end of its column. */
  rank: number | 'bottom'
  /** Other tickets to renumber first (keeping their order) when no rank fits between the neighbours. */
  rebalance: { id: string; rank: number }[]
}

/**
 * Where a ticket goes among `column` (the target column's tickets in order, without or with the moving one):
 * just before `before`, or at the bottom when `before` is null.
 */
export function placement(column: { id: string; rank: number }[], movingId: string, before: string | null): Placement {
  if (before === null) return { rank: 'bottom', rebalance: [] }
  if (before === movingId) throw new Error('A ticket cannot be placed before itself')
  const others = column.filter((t) => t.id !== movingId)
  const i = others.findIndex((t) => t.id === before)
  if (i < 0) throw new Error(`That ticket isn't in the column: ${before}`)
  const next = others[i]!.rank
  if (i === 0) return { rank: next - 1, rebalance: [] }
  const prev = others[i - 1]!.rank
  const mid = (prev + next) / 2
  if (mid > prev && mid < next) return { rank: mid, rebalance: [] }
  return { rank: i + 0.5, rebalance: others.map((t, k) => ({ id: t.id, rank: k + 1 })) }
}
