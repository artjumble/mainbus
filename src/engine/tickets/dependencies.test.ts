import { describe, expect, test } from 'vitest'
import { checkBlockers } from './dependencies'

const tickets = [1, 2, 3, 4].map((n) => ({ id: `t${n}`, number: n }))
const edges = (pairs: [string, string[]][]) => new Map(pairs)

describe('checkBlockers', () => {
  test('accepts tickets of the workspace and keeps a repeated one once', () => {
    expect(checkBlockers('t1', ['t2', 't3', 't2'], tickets, edges([]))).toEqual({ ok: true, ids: ['t2', 't3'] })
    expect(checkBlockers('t1', [], tickets, edges([]))).toEqual({ ok: true, ids: [] })
    expect(checkBlockers(null, ['t2'], tickets, edges([]))).toEqual({ ok: true, ids: ['t2'] })
  })

  test('refuses a ticket blocked by itself', () => {
    expect(checkBlockers('t1', ['t1'], tickets, edges([]))).toEqual({ ok: false, reason: "#1 can't be blocked by itself" })
  })

  test('refuses a ticket outside the workspace', () => {
    expect(checkBlockers('t1', ['other'], tickets, edges([])).ok).toBe(false)
  })

  test('refuses a direct cycle, naming the tickets', () => {
    expect(checkBlockers('t1', ['t2'], tickets, edges([['t2', ['t1']]]))).toEqual({
      ok: false,
      reason: "#2 is already blocked by #1, so #1 can't be blocked by #2"
    })
  })

  test('refuses a cycle through other tickets', () => {
    const r = checkBlockers('t1', ['t2'], tickets, edges([['t2', ['t3']], ['t3', ['t4']], ['t4', ['t1']]]))
    expect(r.ok).toBe(false)
  })

  test('a diamond is not a cycle', () => {
    const r = checkBlockers('t1', ['t2', 't3'], tickets, edges([['t2', ['t4']], ['t3', ['t4']]]))
    expect(r).toEqual({ ok: true, ids: ['t2', 't3'] })
  })

  test("replacing a ticket's own blockers is not a cycle with its old ones", () => {
    expect(checkBlockers('t1', ['t3'], tickets, edges([['t1', ['t2']]])).ok).toBe(true)
  })
})
