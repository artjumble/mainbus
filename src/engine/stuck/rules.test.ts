import { describe, expect, test } from 'vitest'
import type { StoredEvent, ThreadEvent } from '../../shared/events'
import { STUCK } from './config'
import { evaluate, longTurn, noProgress, repeatedFailure, silence, toolKindsSeen, type RuleInput } from './rules'

const T0 = Date.parse('2026-11-02T09:00:00.000Z')
const MIN = 60_000

let seq = 0
function at(ms: number, event: ThreadEvent): StoredEvent {
  return { runId: 'r', seq: ++seq, at: new Date(ms).toISOString(), event }
}

/** `n` attempts at a command that failed, each a call and its result; a `#` in the command is the attempt's number. */
function failures(command: string, n: number, start = 0, tool = 'Bash'): StoredEvent[] {
  const events: StoredEvent[] = []
  for (let i = 0; i < n; i++) {
    const id = `${command}-${tool}-${start + i}`
    events.push(at(T0, { kind: 'tool_call', id, name: tool, input: { command: command.replace('#', String(start + i)) } }))
    events.push(at(T0, { kind: 'tool_result', id, ok: false, summary: 'exit code 1' }))
  }
  return events
}

/** An input that fires no rule, `over` changing what a test is about. */
function input(over: Partial<RuleInput> = {}): RuleInput {
  return {
    now: T0 + 5 * MIN,
    events: [],
    lastActivityAt: T0 + 5 * MIN,
    startedAt: T0,
    turnStartedAt: T0,
    inTurn: true,
    waitEndedAt: null,
    filesChangedAt: null,
    ...over
  }
}

describe('repeated failure', () => {
  test('fires at the fifth failure in a row, and not at the fourth', () => {
    expect(repeatedFailure(failures('npm test', 4))).toBeNull()
    expect(repeatedFailure(failures('npm test', 5))).toEqual({
      rule: 'repeated_failure',
      count: 5,
      evidence: ['Bash failed 5 times in a row: npm test', 'Last error: exit code 1']
    })
  })

  test('counts attempts that differ only in numbers or temp paths as the same command', () => {
    expect(repeatedFailure(failures('node run.js C:\\Temp\\a# --seed #', 5))?.rule).toBe('repeated_failure')
  })

  test('a different command, or a success, in between starts the count again', () => {
    expect(repeatedFailure([...failures('npm test', 4), ...failures('npm run lint', 1), ...failures('npm test', 4)])).toBeNull()

    const ok = [at(T0, { kind: 'tool_call', id: 'ok', name: 'Bash', input: { command: 'ls' } }), at(T0, { kind: 'tool_result', id: 'ok', ok: true, summary: '' })]
    expect(repeatedFailure([...failures('npm test', 4), ...ok, ...failures('npm test', 4, 4)])).toBeNull()
    expect(repeatedFailure([...failures('npm test', 4), ...ok, ...failures('npm test', 5, 4)])?.rule).toBe('repeated_failure')
  })

  test('the same text through another tool is another command', () => {
    expect(repeatedFailure([...failures('x', 3), ...failures('x', 2, 3, 'Read')])).toBeNull()
  })

  test('a custom count is honoured', () => {
    expect(repeatedFailure(failures('npm test', 2), 2)?.rule).toBe('repeated_failure')
  })
})

describe('no progress', () => {
  const calls = [at(T0, { kind: 'tool_call', id: 'a', name: 'Bash', input: {} }), at(T0, { kind: 'tool_call', id: 'b', name: 'Read', input: {} })]

  test('fires after 15 minutes with no file change and no new tool kind, and not a moment before', () => {
    expect(noProgress(input({ events: calls, now: T0 + 15 * MIN - 1 }))).toBeNull()
    expect(noProgress(input({ events: calls, now: T0 + 15 * MIN }))).toEqual({
      rule: 'no_progress',
      evidence: ['No file changed in the worktree and no new kind of tool was used for 15 minutes', 'Tools used so far: Bash, Read']
    })
  })

  test('a file change, a new tool kind, a new turn or a wait that ended restarts the count', () => {
    const now = T0 + 20 * MIN
    expect(noProgress(input({ events: calls, now, filesChangedAt: T0 + 10 * MIN }))).toBeNull()
    expect(noProgress(input({ events: [...calls, at(T0 + 10 * MIN, { kind: 'tool_call', id: 'c', name: 'Edit', input: {} })], now }))).toBeNull()
    expect(noProgress(input({ events: calls, now, turnStartedAt: T0 + 10 * MIN }))).toBeNull()
    expect(noProgress(input({ events: calls, now, waitEndedAt: T0 + 10 * MIN }))).toBeNull()
  })

  test('a tool kind seen before does not count as new', () => {
    const again = at(T0 + 14 * MIN, { kind: 'tool_call', id: 'd', name: 'Bash', input: {} })
    expect(noProgress(input({ events: [...calls, again], now: T0 + 16 * MIN }))?.rule).toBe('no_progress')
  })
})

describe('silence', () => {
  test('fires after 10 minutes without any event, and not a moment before', () => {
    expect(silence(input({ lastActivityAt: T0, now: T0 + 10 * MIN - 1 }))).toBeNull()
    expect(silence(input({ lastActivityAt: T0, now: T0 + 10 * MIN }))).toEqual({
      rule: 'silence',
      evidence: ['No events from the agent for 10 minutes']
    })
  })

  test('does not fire while a command waits for its result within its timeout, and fires after it', () => {
    const call = (extra: object) => [at(T0, { kind: 'tool_call', id: 'long', name: 'Bash', input: { command: 'npm test', ...extra } })]
    const events = call({ timeout: 25 * MIN })
    expect(silence(input({ events, lastActivityAt: T0, now: T0 + 25 * MIN - 1 }))).toBeNull()
    expect(silence(input({ events, lastActivityAt: T0, now: T0 + 25 * MIN }))?.rule).toBe('silence')
    // The default timeout is two minutes, so the usual ten minutes of silence still counts.
    expect(silence(input({ events: call({}), lastActivityAt: T0, now: T0 + 10 * MIN }))?.rule).toBe('silence')
    // A call that has its result is not waiting.
    const done = [...events, at(T0, { kind: 'tool_result', id: 'long', ok: true, summary: '' })]
    expect(silence(input({ events: done, lastActivityAt: T0, now: T0 + 10 * MIN }))?.rule).toBe('silence')
  })

  test('counts from the end of a declared wait that has passed', () => {
    const base = { lastActivityAt: T0, waitEndedAt: T0 + 30 * MIN }
    expect(silence(input({ ...base, now: T0 + 39 * MIN }))).toBeNull()
    expect(silence(input({ ...base, now: T0 + 40 * MIN }))?.rule).toBe('silence')
  })
})

describe('long turn', () => {
  test('fires when one turn has run for 60 minutes, and not a moment before', () => {
    expect(longTurn(input({ now: T0 + 60 * MIN - 1 }))).toBeNull()
    expect(longTurn(input({ now: T0 + 60 * MIN }))).toEqual({
      rule: 'long_turn',
      evidence: ['The current turn has been running for 60 minutes']
    })
  })

  test('needs a turn under way', () => {
    expect(longTurn(input({ now: T0 + 90 * MIN, inTurn: false }))).toBeNull()
  })
})

describe('evaluate', () => {
  test('fires nothing for a healthy run', () => {
    expect(evaluate(input())).toBeNull()
  })

  test('the thresholds are the defaults', () => {
    expect([STUCK.repeatedFailures, STUCK.noProgressMs / MIN, STUCK.silenceMs / MIN, STUCK.longTurnMs / MIN]).toEqual([5, 15, 10, 60])
  })

  test('reports the first rule that fires: repeated failure, then no progress, silence, long turn', () => {
    const stale = { now: T0 + 90 * MIN, lastActivityAt: T0 }
    expect(evaluate(input({ events: failures('npm test', 5), ...stale }))?.rule).toBe('repeated_failure')
    expect(evaluate(input({ ...stale }))?.rule).toBe('no_progress')
    expect(evaluate(input({ ...stale, filesChangedAt: T0 + 80 * MIN }))?.rule).toBe('silence')
    expect(evaluate(input({ now: T0 + 90 * MIN, lastActivityAt: T0 + 90 * MIN, filesChangedAt: T0 + 80 * MIN }))?.rule).toBe('long_turn')
  })
})

describe('toolKindsSeen', () => {
  test('gives the first time each tool name was called', () => {
    const events = [
      at(T0, { kind: 'tool_call', id: '1', name: 'Bash', input: {} }),
      at(T0 + MIN, { kind: 'tool_call', id: '2', name: 'Read', input: {} }),
      at(T0 + 2 * MIN, { kind: 'tool_call', id: '3', name: 'Bash', input: {} })
    ]
    expect([...toolKindsSeen(events)]).toEqual([
      ['Bash', T0],
      ['Read', T0 + MIN]
    ])
  })
})
