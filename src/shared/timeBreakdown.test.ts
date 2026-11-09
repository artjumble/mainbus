import { describe, expect, it } from 'vitest'
import { classifyCommand, classifyTool } from './commandCategory'
import type { Decision } from './domain'
import type { StoredEvent, ThreadEvent } from './events'
import { runBreakdown, ticketTime, timeReportCsv, workspaceTimeReport, formatMinutes, type TimeRunInput, type TimedTicket } from './timeBreakdown'
import { isUsagePauseNotice, usagePauseReason } from './usage'

const T0 = Date.UTC(2026, 0, 1, 10, 0, 0)
const iso = (sec: number): string => new Date(T0 + sec * 1000).toISOString()
const S = 1000

let seq = 0
function ev(runId: string, sec: number, event: ThreadEvent): StoredEvent {
  return { runId, seq: ++seq, at: iso(sec), event }
}
const usage = (durationMs: number): ThreadEvent => ({
  kind: 'usage', models: {}, durationMs, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0
})
const run = (over: Partial<TimeRunInput> = {}): TimeRunInput => ({ id: 'r1', ticketRunId: 'tr1', role: 'Implementer', startedAt: iso(0), endedAt: iso(100), ...over })
const decision = (over: Partial<Decision>): Decision =>
  ({
    id: 'd1', ticketId: 't', agentRunId: 'r1', kind: 'permission', question: '', request: null, options: [], recommended: null, allowAlways: true,
    status: 'answered', deferredUntil: null, answer: null, createdAt: iso(0), answeredAt: iso(10), answeredBy: 'user', answeredVia: null, ...over
  }) as Decision
const bash = (id: string, command: string): ThreadEvent => ({ kind: 'tool_call', id, name: 'Bash', input: { command } })
const result = (id: string): ThreadEvent => ({ kind: 'tool_result', id, ok: true, summary: '' })
const secs = (m: number): number => m / S

function breakdown(events: StoredEvent[], decisions: Decision[] = [], r = run()) {
  const b = runBreakdown({ run: r, events, decisions, now: T0 + 1_000_000 })
  const sum = Object.values(b.byCategory).reduce((a, c) => a + c, 0)
  expect(sum).toBe(b.totalMs)
  return b
}

describe('classifyCommand', () => {
  it.each([
    ['pnpm test', 'tests'],
    ['npx vitest related src/a.ts --run', 'tests'],
    ['pnpm e2e', 'tests'],
    ['cd x && pnpm test', 'tests'],
    ['python -m pytest -q', 'tests'],
    ['pnpm exec playwright test', 'tests'],
    ['pnpm typecheck', 'build'],
    ['npx tsc --noEmit -p tsconfig.node.json', 'build'],
    ['pio run -e esp32', 'build'],
    ['pnpm install && pnpm build', 'build'],
    ['cd x && pnpm install', 'install'],
    ['npm ci', 'install'],
    ['pip install -r r.txt', 'install'],
    ['python -m venv .venv', 'install'],
    ['git status && ls', 'git'],
    ['cat a | node x', 'other_tool'],
    ['echo x > f', 'editing'],
    ['sed -i s/a/b/ f', 'editing'],
    ['sed -n 1,5p f', 'reading'],
    ['grep vitest src', 'reading'],
    ['ls -la', 'reading'],
    ['Get-Content a.txt | Select-String foo', 'reading'],
    ['Set-Content -Path a -Value b', 'editing'],
    ['cd src', 'other_tool'],
    ['node build.js 2>&1', 'other_tool'],
    ['git commit -m "a && pnpm test"', 'git']
  ])('%s is %s', (cmd, cat) => expect(classifyCommand(cmd)).toBe(cat))

  it('classifies tools by name', () => {
    expect(classifyTool('Read', null)).toBe('reading')
    expect(classifyTool('Edit', null)).toBe('editing')
    expect(classifyTool('WebFetch', null)).toBe('web')
    expect(classifyTool('mcp__mainbus__handoff', null)).toBe('mainbus')
    expect(classifyTool('TodoWrite', null)).toBe('other_tool')
    expect(classifyTool('PowerShell', 'pnpm test')).toBe('tests')
  })
})

describe('runBreakdown', () => {
  it('gives the remainder of a turn to the model and the rest to between', () => {
    const b = breakdown([
      ev('r1', 10, { kind: 'session', sessionId: 's' }),
      ev('r1', 20, bash('a', 'pnpm test')),
      ev('r1', 50, result('a')),
      ev('r1', 60, usage(50 * S)),
      ev('r1', 60, { kind: 'turn_end', ok: true })
    ])
    expect(b.byCategory.tests).toBe(30 * S)
    expect(b.byCategory.model).toBe(20 * S)
    expect(b.byCategory.between).toBe(50 * S)
    expect(b.totalMs).toBe(100 * S)
    expect(b.commands).toEqual([{ command: 'pnpm test', count: 1, ms: 30 * S }])
  })

  it('lets a permission card open during a command win', () => {
    const b = breakdown(
      [ev('r1', 5, bash('a', 'pnpm test')), ev('r1', 40, result('a')), ev('r1', 41, { kind: 'turn_end', ok: true })],
      [decision({ createdAt: iso(10), answeredAt: iso(30) })]
    )
    expect(b.byCategory.permission).toBe(20 * S)
    expect(b.byCategory.tests).toBe(15 * S)
  })

  it('counts a question open after the turn ended, deferred ones until the run ends', () => {
    const b = breakdown(
      [ev('r1', 5, { kind: 'message', text: 'x' }), ev('r1', 10, { kind: 'turn_end', ok: true })],
      [decision({ kind: 'question', createdAt: iso(10), answeredAt: null, status: 'deferred' })]
    )
    expect(b.byCategory.question).toBe(90 * S)
    expect(b.byCategory.model).toBe(5 * S)
  })

  it('starts the turn after an answer at the answer', () => {
    const b = breakdown(
      [
        ev('r1', 5, { kind: 'message', text: 'x' }),
        ev('r1', 10, { kind: 'turn_end', ok: true }),
        ev('r1', 50, { kind: 'message', text: 'y' }),
        ev('r1', 60, { kind: 'turn_end', ok: true })
      ],
      [decision({ kind: 'question', createdAt: iso(10), answeredAt: iso(40) })]
    )
    expect(b.byCategory.question).toBe(30 * S)
    expect(b.byCategory.model).toBe(5 * S + 20 * S)
  })

  it('counts pause until resume, and without a resume until the end', () => {
    const resumed = breakdown([ev('r1', 10, { kind: 'paused' }), ev('r1', 30, { kind: 'resumed' })])
    expect(resumed.byCategory.paused).toBe(20 * S)
    const open = breakdown([ev('r1', 10, { kind: 'paused' })])
    expect(open.byCategory.paused).toBe(90 * S)
  })

  it('counts a usage-limit notice until the next session, then the queue', () => {
    const b = breakdown([
      ev('r1', 10, { kind: 'notice', text: usagePauseReason({ kind: 'limited', resetsAt: null, retryAt: null, paused: 1 }) }),
      ev('r1', 50, { kind: 'queued' }),
      ev('r1', 60, { kind: 'session', sessionId: 's' })
    ])
    expect(b.byCategory.usage_limited).toBe(40 * S)
    expect(b.byCategory.queued).toBe(10 * S)
    expect(isUsagePauseNotice('Something else')).toBe(false)
  })

  it('counts queued until the process starts, even when a message arrives meanwhile', () => {
    const b = breakdown([
      ev('r1', 10, { kind: 'queued' }),
      ev('r1', 20, { kind: 'user_message', text: 'hi' }),
      ev('r1', 70, { kind: 'session', sessionId: 's' })
    ])
    expect(b.byCategory.queued).toBe(60 * S)
  })

  it('counts a setup step over its duration', () => {
    const b = breakdown([ev('r1', 40, { kind: 'setup', command: 'pnpm i', outcome: 'succeeded', exitCode: 0, durationMs: 30 * S, tail: [], log: '' })])
    expect(b.byCategory.setup).toBe(30 * S)
  })

  it('counts parallel calls once, and the highest-priority category when they differ', () => {
    const b = breakdown([
      ev('r1', 10, { kind: 'tool_call', id: 'a', name: 'Read', input: { file_path: 'a' } }),
      ev('r1', 10, { kind: 'tool_call', id: 'b', name: 'Read', input: { file_path: 'b' } }),
      ev('r1', 20, result('a')),
      ev('r1', 20, result('b')),
      ev('r1', 30, bash('c', 'pnpm test')),
      ev('r1', 30, { kind: 'tool_call', id: 'd', name: 'Read', input: { file_path: 'a' } }),
      ev('r1', 40, result('c')),
      ev('r1', 40, result('d'))
    ])
    expect(b.byCategory.reading).toBe(10 * S)
    expect(b.byCategory.tests).toBe(10 * S)
  })

  it('ends a tool with no result at the turn end', () => {
    const b = breakdown([ev('r1', 10, bash('a', 'pnpm build')), ev('r1', 25, { kind: 'turn_end', ok: false, interrupted: true })])
    expect(b.byCategory.build).toBe(15 * S)
  })

  it('uses the usage duration for the turn start, and notes a large disagreement', () => {
    const b = breakdown([ev('r1', 10, { kind: 'message', text: 'x' }), ev('r1', 80, usage(70 * S)), ev('r1', 80, { kind: 'turn_end', ok: true })])
    expect(b.byCategory.model).toBe(70 * S)
    expect(b.byCategory.between).toBe(30 * S)
    expect(b.turnCheck).toEqual({ recordedMs: 70 * S, computedMs: 70 * S, disagrees: false })
    const off = breakdown([ev('r1', 10, { kind: 'message', text: 'x' }), ev('r1', 80, usage(5 * S)), ev('r1', 80, { kind: 'turn_end', ok: true })])
    expect(off.turnCheck?.disagrees).toBe(true)
    expect(breakdown([ev('r1', 10, { kind: 'message', text: 'x' }), ev('r1', 20, { kind: 'turn_end', ok: true })]).turnCheck).toBeNull()
  })

  it('runs to now for a run that has not ended', () => {
    const b = runBreakdown({ run: run({ endedAt: null }), events: [], decisions: [], now: T0 + 30 * S })
    expect(b.totalMs).toBe(30 * S)
    expect(b.byCategory.between).toBe(30 * S)
  })

  it('shows an overnight wait on a pending permission card as waiting on you', () => {
    const night = 10 * 3600
    const b = breakdown(
      [ev('r1', 10, bash('a', 'pnpm test')), ev('r1', night + 20, result('a')), ev('r1', night + 30, { kind: 'turn_end', ok: true })],
      [decision({ createdAt: iso(12), answeredAt: iso(night + 15) })],
      run({ endedAt: iso(night + 40) })
    )
    expect(b.byCategory.permission).toBe((night + 3) * S)
    expect(b.byCategory.tests).toBe(7 * S)
    expect(b.byCategory.model).toBeLessThan(15 * S)
  })
})

describe('ticketTime and the workspace report', () => {
  const runs: TimeRunInput[] = [
    run({ id: 'a', role: 'Planner', startedAt: iso(0), endedAt: iso(20) }),
    run({ id: 'b', role: 'Implementer', startedAt: iso(30), endedAt: iso(130) }),
    run({ id: 'c', role: 'Implementer', startedAt: iso(130), endedAt: iso(150) })
  ]
  const events = [
    ev('a', 5, { kind: 'message', text: 'x' }),
    ev('a', 15, { kind: 'turn_end', ok: true }),
    ev('b', 40, bash('x', 'pnpm   test 12')),
    ev('b', 70, result('x')),
    ev('b', 80, bash('y', 'pnpm test 99')),
    ev('b', 90, result('y')),
    ev('b', 95, { kind: 'turn_end', ok: true })
  ]
  const time = ticketTime({ runs, events, decisions: [], ticketRuns: [{ id: 'tr1', status: 'done', endedAt: iso(150) }], now: T0 + 1000 * S })

  it('merges a role across runs, aggregates commands and times to review', () => {
    expect(time.runCount).toBe(1)
    expect(time.roleCount).toBe(2)
    expect(time.totalMs).toBe(140 * S)
    expect(time.toReviewMs).toBe(150 * S)
    expect(time.runs[0]!.roles.map((r) => [r.role, r.runs])).toEqual([['Planner', 1], ['Implementer', 2]])
    expect(time.commands).toEqual([{ command: 'pnpm test N', count: 2, ms: 40 * S }])
    expect(time.byCategory.tests).toBe(40 * S)
  })

  it('has no time to review before a run is done', () => {
    expect(ticketTime({ runs, events, decisions: [], ticketRuns: [{ id: 'tr1', status: 'running', endedAt: null }], now: T0 }).toReviewMs).toBeNull()
  })

  const ticket = (n: number, title: string, toReview: number): TimedTicket => ({
    ticketId: `t${n}`, number: n, title, time: { ...time, toReviewMs: toReview }
  })

  it('aggregates over tickets with a median and an escaped CSV', () => {
    const report = workspaceTimeReport([ticket(1, '=SUM(A1)', 10 * S), ticket(2, 'Say "hi", ok', 30 * S), ticket(3, 'Plain', 20 * S)])
    expect(report.ticketCount).toBe(3)
    expect(report.medianToReviewMs).toBe(20 * S)
    expect(report.byCategory.tests).toBe(120 * S)
    expect(report.averages.tests).toBe(40 * S)
    expect(report.roles.find((r) => r.role === 'Implementer')?.tickets).toBe(3)
    expect(report.commands[0]).toEqual({ command: 'pnpm test N', count: 6, ms: 120 * S })
    const csv = timeReportCsv(report)
    const lines = csv.trim().split('\r\n')
    expect(lines[0]).toBe('ticket,title,run,role,agent_run_id,started_at,ended_at,category,minutes')
    expect(lines[1]).toContain("'=SUM(A1)")
    expect(csv).toContain('"Say ""hi"", ok"')
    expect(csv).toContain('Tests,0.67')
    expect(workspaceTimeReport([]).medianToReviewMs).toBeNull()
  })

  it('formats minutes', () => {
    expect(formatMinutes(45 * S)).toBe('45 s')
    expect(formatMinutes(31 * 60 * S)).toBe('31 min')
    expect(formatMinutes(65 * 60 * S)).toBe('1 h 05 min')
    expect(secs(5000)).toBe(5)
  })
})
