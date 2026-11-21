import { describe, expect, test } from 'vitest'
import { compareRank, inBoardOrder, isRanked, placement } from './boardOrder'
import type { Column } from './domain'

const t = (id: string, rank: number, number = 1) => ({ id, rank, number })

describe('compareRank', () => {
  test('orders by rank, then number; a missing rank falls back to number', () => {
    expect(compareRank(t('a', 2, 1), t('b', 1, 2))).toBeGreaterThan(0)
    expect(compareRank(t('a', 1, 2), t('b', 1, 1))).toBeGreaterThan(0)
    expect(compareRank({ rank: NaN, number: 1 }, { rank: NaN, number: 2 })).toBeLessThan(0)
  })
})

describe('inBoardOrder', () => {
  test('groups by column in the board order; Backlog and Ready by rank, the rest by number', () => {
    const column: Record<string, Column> = { a: 'ready', b: 'ready', c: 'backlog', d: 'review', e: 'review' }
    const out = inBoardOrder([t('a', 5, 1), t('b', 2, 2), t('c', 1, 3), t('e', 1, 5), t('d', 9, 4)], (x) => column[x.id]!)
    expect(out.map((x) => x.id)).toEqual(['c', 'b', 'a', 'd', 'e'])
  })
  test('isRanked is true for Backlog and Ready only', () => {
    expect((['backlog', 'ready', 'in_progress', 'needs_you', 'review', 'done'] as Column[]).filter(isRanked)).toEqual(['backlog', 'ready'])
  })
})

describe('placement', () => {
  const col = [t('a', 1), t('b', 2), t('c', 3)]
  test('bottom when before is null', () => {
    expect(placement(col, 'a', null)).toEqual({ rank: 'bottom', rebalance: [] })
  })
  test('the top is one less than the first', () => {
    expect(placement(col, 'c', 'a')).toEqual({ rank: 0, rebalance: [] })
  })
  test('the middle is the midpoint of the neighbours, ignoring the moving ticket', () => {
    expect(placement(col, 'c', 'b')).toEqual({ rank: 1.5, rebalance: [] })
    expect(placement(col, 'b', 'c')).toEqual({ rank: 2, rebalance: [] })
  })
  test('a tie or exhausted precision renumbers the others, keeping their order', () => {
    const tied = [t('a', 1), t('b', 1), t('c', 1)]
    const p = placement(tied, 'x', 'b')
    expect(p.rebalance).toEqual([{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }, { id: 'c', rank: 3 }])
    expect(p.rank).toBe(1.5)
    const tight = [t('a', 1), t('b', 1 + Number.EPSILON)]
    expect(placement(tight, 'x', 'b').rebalance).toHaveLength(2)
  })
  test('an unknown before, or the ticket itself, throws', () => {
    expect(() => placement(col, 'a', 'zzz')).toThrow()
    expect(() => placement(col, 'a', 'a')).toThrow()
  })
})
