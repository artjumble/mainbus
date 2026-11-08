import { describe, expect, test } from 'vitest'
import type { StoredEvent, ThreadEvent } from '../../shared/events'
import { STUCK } from './config'
import { evaluate, lastMilestoneAt, longTurn, newCommandFinishedAt, noMilestone, noProgress, repeatedFailure, silence, toolKindsSeen, type RuleInput } from './rules'

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
    committedAt: null,
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
      evidence: [
        'No file changed in the worktree, no new kind of tool was used and no new command finished for 15 minutes',
        'Tools used so far: Bash, Read'
      ]
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

describe('no milestone', () => {
  const say = (m: number): StoredEvent => at(T0 + m * MIN, { kind: 'message', text: 'Working on it' })
  const tick = (m: number): StoredEvent => at(T0 + m * MIN, { kind: 'criterion_checked', index: 0, text: 'It works' })
  const wait = (m: number): StoredEvent => at(T0 + m * MIN, { kind: 'waiting', reason: 'a build', until: new Date(T0 + (m + 5) * MIN).toISOString() })

  test('fires 30 minutes into a turn with no milestone, and not a moment before', () => {
    expect(noMilestone(input({ now: T0 + 30 * MIN - 1 }))).toBeNull()
    expect(noMilestone(input({ now: T0 + 30 * MIN }))).toEqual({
      rule: 'no_milestone',
      evidence: ['No commit, ticked criterion or message for 30 minutes in a turn that has run 30 minutes']
    })
  })

  test('needs a turn under way', () => {
    expect(noMilestone(input({ now: T0 + 90 * MIN, inTurn: false }))).toBeNull()
  })

  test.each([
    ['a message', { events: [say(10)] }],
    ['a ticked criterion', { events: [tick(10)] }],
    ['a declared wait', { events: [wait(10)] }],
    ['a commit', { committedAt: T0 + 10 * MIN }],
    ['the end of a wait', { waitEndedAt: T0 + 10 * MIN }]
  ] as [string, Partial<RuleInput>][])('%s restarts the count', (_name, over) => {
    expect(noMilestone(input({ ...over, now: T0 + 40 * MIN - 1 }))).toBeNull()
    expect(noMilestone(input({ ...over, now: T0 + 40 * MIN }))).toMatchObject({
      rule: 'no_milestone',
      evidence: ['No commit, ticked criterion or message for 30 minutes in a turn that has run 40 minutes']
    })
  })

  test('tool calls, thinking and blank messages are not milestones', () => {
    const events = [
      ...command('npm test', 20, 21),
      ...looks('Read', 25),
      at(T0 + 28 * MIN, { kind: 'thinking', text: 'Hmm' }),
      at(T0 + 29 * MIN, { kind: 'message', text: '  ' })
    ]
    expect(lastMilestoneAt(input({ events }))).toBe(T0)
    expect(noMilestone(input({ events, now: T0 + 30 * MIN }))?.rule).toBe('no_milestone')
  })

  test('a milestone from before the turn started does not count', () => {
    expect(lastMilestoneAt(input({ turnStartedAt: T0 + 50 * MIN, events: [say(10)], committedAt: T0 + 20 * MIN }))).toBe(T0 + 50 * MIN)
  })
})

describe('ceiling', () => {
  test('a turn over 3 hours fires whatever its milestones, and not a moment before', () => {
    const talk = Array.from({ length: 18 }, (_, k) => at(T0 + (k + 1) * 10 * MIN, { kind: 'message', text: 'Still going' }))
    const now = T0 + 180 * MIN
    expect(longTurn(input({ events: talk, now: now - 1 }))).toBeNull()
    expect(longTurn(input({ events: talk, now }))).toEqual({
      rule: 'long_turn',
      evidence: ['The current turn has been running for 180 minutes']
    })
    expect(noMilestone(input({ events: talk, now }))).toBeNull()
    expect(evaluate(input({ events: talk, now, lastActivityAt: now, filesChangedAt: now }))?.rule).toBe('long_turn')
  })

  test('needs a turn under way', () => {
    expect(longTurn(input({ now: T0 + 200 * MIN, inTurn: false }))).toBeNull()
  })
})

describe('evaluate', () => {
  test('fires nothing for a healthy run', () => {
    expect(evaluate(input())).toBeNull()
  })

  test('the thresholds are the defaults', () => {
    expect([STUCK.repeatedFailures, STUCK.noProgressMs / MIN, STUCK.silenceMs / MIN, STUCK.noMilestoneMs / MIN, STUCK.maxTurnMs / MIN]).toEqual([5, 15, 10, 30, 180])
  })

  test('reports the first rule that fires: repeated failure, then no progress, silence, no milestone, long turn', () => {
    const stale = { now: T0 + 90 * MIN, lastActivityAt: T0 }
    expect(evaluate(input({ events: failures('npm test', 5), ...stale }))?.rule).toBe('repeated_failure')
    expect(evaluate(input({ ...stale }))?.rule).toBe('no_progress')
    expect(evaluate(input({ ...stale, filesChangedAt: T0 + 80 * MIN }))?.rule).toBe('silence')
    expect(evaluate(input({ now: T0 + 90 * MIN, lastActivityAt: T0 + 90 * MIN, filesChangedAt: T0 + 80 * MIN }))?.rule).toBe('no_milestone')
    expect(evaluate(input({ now: T0 + 200 * MIN, lastActivityAt: T0 + 200 * MIN, filesChangedAt: T0 + 199 * MIN, committedAt: T0 + 195 * MIN }))?.rule).toBe('long_turn')
  })
})

/** A shell command called at minute `from` and finishing at minute `to`; no `to` leaves it running. */
function command(text: string, from: number, to?: number, opts: { timeout?: number; ok?: boolean; tool?: string } = {}): StoredEvent[] {
  const id = `cmd-${++seq}`
  const input = { command: text, ...(opts.timeout !== undefined ? { timeout: opts.timeout * MIN } : {}) }
  return [
    at(T0 + from * MIN, { kind: 'tool_call', id, name: opts.tool ?? 'Bash', input }),
    ...(to !== undefined ? [at(T0 + to * MIN, { kind: 'tool_result', id, ok: opts.ok ?? true, summary: opts.ok === false ? 'exit code 1' : '' })] : [])
  ]
}

/** A Read or Grep call and its result at each of the given minutes. */
function looks(tool: 'Read' | 'Grep', ...minutes: number[]): StoredEvent[] {
  return minutes.flatMap((m) => {
    const id = `${tool}-${++seq}`
    return [
      at(T0 + m * MIN, { kind: 'tool_call', id, name: tool, input: { file_path: `src/f${m}.ts` } }),
      at(T0 + m * MIN, { kind: 'tool_result', id, ok: true, summary: '' })
    ]
  })
}

/**
 * Runs a scripted thread on a fake clock, checking every rule once a minute up to `end` as the detector would, with
 * only the events up to that moment; gives each minute a rule fired at, and the rule.
 */
function replay(script: StoredEvent[][], end: number): { minute: number; rule: string }[] {
  const events = script.flat().sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const hits: { minute: number; rule: string }[] = []
  for (let minute = 0; minute <= end; minute++) {
    const now = T0 + minute * MIN
    const sofar = events.filter((e) => Date.parse(e.at) <= now)
    const lastActivityAt = Math.max(T0, ...sofar.map((e) => Date.parse(e.at)))
    // File changes are seen the way the worktree probe would: the last edit or write so far.
    const edits = sofar.filter((e) => e.event.kind === 'tool_call' && (e.event.name === 'Edit' || e.event.name === 'Write'))
    const filesChangedAt = edits.length > 0 ? Date.parse(edits.at(-1)!.at) : null
    const hit = evaluate(input({ now, events: sofar, lastActivityAt, filesChangedAt }))
    if (hit) hits.push({ minute, rule: hit.rule })
  }
  return hits
}

describe('no progress while commands keep finishing', () => {
  test('a Reviewer-like run, Bash and reads only, with different commands finishing every 3 to 8 minutes for 40 minutes, gets no hit', () => {
    const script = [
      command('git diff main...HEAD', 0, 1),
      looks('Read', 2, 3),
      command('npx vitest run src/engine/stuck', 4, 5),
      looks('Grep', 6, 8, 10),
      command('npx tsc --noEmit', 11, 12),
      looks('Read', 14, 16, 18),
      command('git log --oneline -5', 19, 20),
      looks('Read', 22, 24),
      command('npx vitest run src/engine/runner', 25, 26),
      looks('Grep', 28, 30, 32),
      command('git diff main...HEAD -- src/engine/stuck/rules.ts', 33, 34),
      looks('Read', 36, 38),
      command('git status', 39, 40),
      saying(20)
    ]
    expect(replay(script, 40)).toEqual([])
    // The old rule, counting only file changes and new tool kinds, fired here from minute 21: Grep, first used at minute 6, was the last new thing.
  })

  test('the same, with one 10-minute command still running within its timeout, gets no hit', () => {
    const script = [
      command('git diff main...HEAD', 0, 1),
      looks('Read', 2, 3),
      command('npx tsc --noEmit', 4, 6),
      looks('Grep', 8, 10, 12, 14),
      command('npx vitest run', 15, 25, { timeout: 20 }),
      looks('Read', 27, 30),
      command('git status', 31, 32),
      looks('Read', 34, 37, 40),
      saying(20)
    ]
    expect(replay(script, 40)).toEqual([])
    // Minutes 23 and 24 are 15 or more since the last new thing, Grep first used at minute 8: once the command's timeout has run out, they hit.
    const ended = [...script.slice(0, 4), command('npx vitest run', 15, undefined, { timeout: 5 })]
    expect(replay(ended, 24)[0]).toEqual({ minute: 23, rule: 'no_progress' })
  })

  test('a command is new when it differs from each of the last 5 finished; numbers and temp paths do not make it differ', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].flatMap((c, i) => command(`echo ${c}`, i, i))
    expect(newCommandFinishedAt([...five, ...command('echo a', 10, 10)])).toBe(T0 + 4 * MIN)
    expect(newCommandFinishedAt([...five, ...command('echo f', 5, 5), ...command('echo a', 10, 10)])).toBe(T0 + 10 * MIN)
    expect(newCommandFinishedAt([...command('npx vitest run --seed 1', 0, 1), ...command('npx vitest run --seed 2', 2, 3)])).toBe(T0 + MIN)
    // A command still running, or a tool other than the shell, is not a finished command.
    expect(newCommandFinishedAt([...command('npm test', 0)])).toBeNull()
    expect(newCommandFinishedAt([...looks('Read', 1)])).toBeNull()
    expect(newCommandFinishedAt([...command('npm test', 0, 1, { tool: 'PowerShell' })])).toBe(T0 + MIN)
  })

  test('the same command finishing over and over for 15 minutes with no file changes still hits', () => {
    const script = [0, 2, 4, 6, 8, 10, 12, 14].map((m) => command(`npx vitest run --seed ${m}`, m, m + 1))
    // The first run finishing at minute 1 is the last new thing.
    expect(replay(script, 17)[0]).toEqual({ minute: 16, rule: 'no_progress' })
  })

  test('two commands taking turns are not new either', () => {
    const script = [0, 2, 4, 6, 8, 10, 12, 14, 16].map((m) => command(m % 4 === 0 ? 'npm test' : 'npm run lint', m, m + 1))
    // Each is new once, the second finishing at minute 3.
    expect(replay(script, 18)[0]).toEqual({ minute: 18, rule: 'no_progress' })
  })

  test('Read and Grep only, with no command finishing for 15 minutes, still hits', () => {
    const script = [command('npx tsc --noEmit', 0, 1), looks('Read', 2, 4, 6, 8, 10, 12, 14, 16), looks('Grep', 3, 5, 7, 9, 11, 13, 15)]
    // The last new things were the command at minute 1 and the first Grep at minute 3.
    expect(replay(script, 18)[0]).toEqual({ minute: 18, rule: 'no_progress' })
  })

  test('repeated failures and long turns are still caught while commands keep finishing', () => {
    const failing = [0, 2, 4, 6, 8].map((m) => command('npm test', m, m + 1, { ok: false }))
    expect(replay([command('npx tsc --noEmit', 0, 0), ...failing], 9)[0]).toEqual({ minute: 9, rule: 'repeated_failure' })

    const busy = Array.from({ length: 13 }, (_, k) => command(`npx vitest run src/part${'abcdefghijklm'[k]}.test.ts`, k * 5, k * 5 + 1))
    // With no milestone in the whole turn, the milestone rule is what catches it.
    expect(replay(busy, 61)[0]).toEqual({ minute: 30, rule: 'no_milestone' })
  })
})

/** A file edit at each of the given minutes. */
function edits(...minutes: number[]): StoredEvent[] {
  return minutes.flatMap((m) => {
    const id = `edit-${++seq}`
    return [
      at(T0 + m * MIN, { kind: 'tool_call', id, name: 'Edit', input: { file_path: `src/f${m}.ts` } }),
      at(T0 + m * MIN, { kind: 'tool_result', id, ok: true, summary: '' })
    ]
  })
}

const saying = (m: number): StoredEvent[] => [at(T0 + m * MIN, { kind: 'message', text: 'Status update' })]

describe('replays of the milestone rule', () => {
  test('churn: edits and different commands every few minutes for 40 minutes, with no commit, tick or message, hit at 30', () => {
    const script = [
      edits(1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34, 37, 40),
      ...[2, 6, 11, 15, 20, 24, 29, 33, 38].map((m) => command(`npx vitest run src/part${m}.test.ts`, m, m + 1))
    ]
    expect(replay(script, 40)[0]).toEqual({ minute: 30, rule: 'no_milestone' })
  })

  test('#79: 80 minutes of edits, test runs, an e2e pass and a status message every 15 to 20 minutes gets no hit', () => {
    // Rebuilt from the ticket's account of the run (11:03 to 12:23), not from its stored events, which the tests cannot reach.
    const script = [
      edits(2, 5, 9, 14, 18, 22, 27, 31, 36, 40, 44, 49, 53, 58, 62, 66, 70, 74, 78),
      ...[3, 8, 13, 19, 25, 32, 38, 45, 52, 59, 67, 75].map((m) => command(`npx vitest related src/engine/f${m}.ts --run`, m, m + 1)),
      command('npx playwright test e2e/stuck.spec.ts', 41, 44, { timeout: 10 }),
      [16, 33, 51, 68, 79].flatMap(saying)
    ]
    expect(replay(script, 80)).toEqual([])
  })

  test('a commit or a tick every 25 minutes keeps a long busy turn quiet until the 3 hour ceiling', () => {
    const script = [edits(...Array.from({ length: 90 }, (_, k) => 1 + k * 2)), [20, 45, 70, 95, 120, 145, 170].flatMap((m) => [at(T0 + m * MIN, { kind: 'criterion_checked', index: 0, text: 'x' })])]
    expect(replay(script, 181)[0]).toEqual({ minute: 180, rule: 'long_turn' })
  })
})

describe('replays of the #57 and #68 false alarms', () => {
  // Rebuilt from the tickets' accounts of the runs, not copied from their stored events, which the tests cannot reach.
  test('#57: a Reviewer running the unit suite, then main\'s suite, then a narrowed suite, gets no hit', () => {
    const script = [
      looks('Read', 0, 1),
      command('git diff main...HEAD --stat', 1, 2),
      command('npx vitest run', 3, 8, { timeout: 15 }),
      looks('Grep', 9),
      command('cd ../main && npx vitest run', 10, 16, { timeout: 15 }),
      looks('Read', 17, 18),
      command('npx vitest run src/engine/stuck src/engine/runner', 19, 22, { timeout: 10 }),
      looks('Read', 24, 27, 30, 33),
      command('git diff main...HEAD -- src/engine/stuck', 34, 35),
      looks('Grep', 37, 40),
      saying(20)
    ]
    expect(replay(script, 40)).toEqual([])
  })

  test('#68: an Implementer after a clean typecheck, with two full unit runs and three focused test files, gets no hit', () => {
    const script = [
      command('npx tsc --noEmit', 0, 1, { timeout: 5 }),
      command('npx vitest run', 2, 9, { timeout: 15 }),
      looks('Read', 9),
      command('npx vitest run', 10, 18, { timeout: 15 }),
      command('npx vitest run src/engine/runner/ticketRunner.test.ts', 19, 21, { timeout: 5 }),
      command('npx vitest run src/engine/stuck/rules.test.ts', 22, 24, { timeout: 5 }),
      command('npx vitest run src/engine/roles/prompt.test.ts', 25, 27, { timeout: 5 }),
      looks('Read', 29, 33, 37, 40),
      saying(20)
    ]
    expect(replay(script, 40)).toEqual([])
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
