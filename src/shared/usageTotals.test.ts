import { describe, expect, test } from 'vitest'
import type { StoredEvent, ThreadEvent, ThreadRun, UsageEvent } from './events'
import { formatAgentTime, formatCost, formatTokens, orchestratorUsage, sessionUsageSoFar, ticketUsage, usageLine } from './usageTotals'

const usage = (input: number, extra: Partial<UsageEvent> = {}): UsageEvent => ({
  kind: 'usage',
  inputTokens: input,
  outputTokens: 1,
  cacheReadTokens: 2,
  cacheWriteTokens: 3,
  models: { m: { inputTokens: input, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, costUsd: 0.5 } },
  costUsd: 0.5,
  durationMs: 1000,
  ...extra
})
let seq = 0
const stored = (runId: string, event: ThreadEvent): StoredEvent => ({ runId, seq: ++seq, at: '2026-01-01T00:00:00Z', event })
const run = (id: string, ticketRunId: string, role: string): ThreadRun => ({ id, ticketRunId, role })

describe('ticketUsage', () => {
  const runs = [run('a1', 'tr1', 'Planner'), run('a2', 'tr1', 'Implementer'), run('a3', 'tr1', 'Implementer'), run('b1', 'tr2', 'Planner')]

  test('totals by run and role, replaced roles summed, Mainbus calls apart', () => {
    const events = [
      stored('a1', usage(10)),
      stored('a2', usage(20)),
      stored('a3', usage(30)),
      stored('a1', usage(5, { call: 'summary', durationMs: 7000 })),
      stored('b1', { kind: 'notice', text: 'x' })
    ]
    const t = ticketUsage(events, runs)
    expect(t.total).toMatchObject({ inputTokens: 65, turns: 3, agentMs: 3000, costUsd: 2, models: ['m'] })
    expect(t.runs.map((r) => r.n)).toEqual([1, 2])
    const [r1, r2] = t.runs
    expect(r1.roles.map((r) => r.role)).toEqual(['Planner', 'Implementer'])
    expect(r1.roles[0].usage).toMatchObject({ inputTokens: 10, turns: 1 })
    expect(r1.roles[1].usage).toMatchObject({ inputTokens: 50, turns: 2 })
    expect(r1.mainbus).toMatchObject({ inputTokens: 5, turns: 0, agentMs: 0 })
    expect(r2.usage).toBeNull()
    expect(r2.roles).toEqual([{ role: 'Planner', usage: null }])
  })

  test('null, not zero, when nothing was recorded', () => {
    expect(ticketUsage([stored('a1', { kind: 'notice', text: 'x' })], runs).total).toBeNull()
  })

  test('a cost is null when no event had one', () => {
    const { models: _m, costUsd: _c, ...bare } = usage(1)
    const t = ticketUsage([stored('a1', { ...bare, models: {} })], runs)
    expect(t.total?.costUsd).toBeNull()
  })

  test('accepts runs by id', () => {
    expect(ticketUsage([stored('a1', usage(1))], { a1: runs[0] }).total?.turns).toBe(1)
  })
})

test('orchestratorUsage', () => {
  expect(orchestratorUsage([])).toBeNull()
  expect(orchestratorUsage([stored('o', usage(4)), stored('o', usage(6))])?.inputTokens).toBe(10)
})

describe('sessionUsageSoFar', () => {
  test('follows session boundaries and ignores Mainbus calls', () => {
    const events: ThreadEvent[] = [
      { kind: 'session', sessionId: 's1' },
      usage(10),
      usage(99, { call: 'summary' }),
      { kind: 'session', sessionId: 's2' },
      usage(5),
      { kind: 'session', sessionId: 's1' },
      usage(1)
    ]
    expect(sessionUsageSoFar(events, 's1').m).toMatchObject({ inputTokens: 11, costUsd: 1 })
    expect(sessionUsageSoFar(events, 's2').m.inputTokens).toBe(5)
    expect(sessionUsageSoFar(events, 's3')).toEqual({})
  })
})

test('formatters', () => {
  expect([950, 12_300, 1_200_000, 12_000].map(formatTokens)).toEqual(['950', '12.3k', '1.2M', '12k'])
  expect([45_000, 12 * 60_000, 65 * 60_000].map(formatAgentTime)).toEqual(['45s', '12m', '1h 05m'])
  expect([0.42, 0.004, null].map(formatCost)).toEqual(['$0.42', 'under $0.01', 'n/a'])
  expect(usageLine(ticketUsage([stored('a1', usage(10))], [run('a1', 't', 'P')]).total!)).toContain('API-equivalent cost $0.50, not billed on the user')
})
