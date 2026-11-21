import type { ArchivedTicket } from '../../../shared/domain'
import { groupByMonth } from './groupByMonth'

// Mid-month, mid-day dates: no time zone moves them into another month.
const at = (n: number, archivedAt: string): ArchivedTicket => ({ id: `t${n}`, number: n, title: `T${n}`, labels: [], kind: 'change', doneAt: null, archivedAt })

test('groups newest-first tickets by the month they were archived, keeping the order', () => {
  const groups = groupByMonth(
    [at(5, '2026-11-15T12:00:00.000Z'), at(4, '2026-11-14T12:00:00.000Z'), at(3, '2026-10-15T12:00:00.000Z'), at(2, '2025-10-15T12:00:00.000Z')],
    'en-US'
  )
  expect(groups.map((g) => g.heading)).toEqual(['November 2026', 'October 2026', 'October 2025'])
  expect(groups.map((g) => g.tickets.map((t) => t.number))).toEqual([[5, 4], [3], [2]])
  expect(new Set(groups.map((g) => g.key)).size).toBe(3)
})

test('no tickets, no groups', () => {
  expect(groupByMonth([])).toEqual([])
})
