import { describe, expect, it } from 'vitest'
import type { BaseTestCommandResult } from '../../shared/domain'
import type { BaseTestRun } from '../store/baseTests'
import { baseTestsSummary, knownFailures } from './known'

function result(name: string, failures: string[], exitCode: number | null = failures.length > 0 ? 1 : 0, timedOut = false): BaseTestCommandResult {
  return { name, command: 'x', format: 'vitest-json', exitCode, timedOut, durationMs: 1, failures, tail: [], note: null }
}

let n = 0
function run(results: BaseTestCommandResult[], extra: Partial<BaseTestRun> = {}): BaseTestRun {
  n += 1
  return {
    id: `r${n}`,
    workspaceId: 'w',
    baseRef: 'origin/main',
    baseSha: `sha${n}`.padEnd(40, '0'),
    trigger: 'manual',
    startedAt: '2026-11-07T10:00:00.000Z',
    endedAt: '2026-11-07T10:05:00.000Z',
    error: null,
    results,
    ...extra
  }
}

const unit = [{ name: 'Unit' }]

describe('knownFailures', () => {
  it('lists the failures of the latest run, with their counts', () => {
    const runs = [run([result('Unit', ['a > b'])]), run([result('Unit', ['a > b'])])]
    expect(knownFailures(runs, unit)).toEqual([
      { command: 'Unit', test: 'a > b', failedRuns: 2, ofRuns: 2, intermittent: false, inLatest: true, exitCode: 1 }
    ])
  })

  it('marks a test that failed in some runs and passed in others as intermittent, even when it passed in the latest', () => {
    const runs = [run([result('Unit', ['flaky'])]), run([result('Unit', [])]), run([result('Unit', ['flaky', 'always'])]), run([result('Unit', ['always'])])]
    const known = knownFailures(runs, unit)
    expect(known.map((k) => [k.test, k.failedRuns, k.ofRuns, k.intermittent, k.inLatest])).toEqual([
      ['always', 2, 4, true, false],
      ['flaky', 2, 4, true, true]
    ])
  })

  it('lists nothing when no run failed', () => {
    expect(knownFailures([run([result('Unit', [])])], unit)).toEqual([])
  })

  it('ignores runs that could not run the commands, and commands that are no longer configured', () => {
    const runs = [
      run([], { error: 'setup failed' }),
      run([result('Unit', ['a']), result('Old', ['gone'])]),
      run([result('Unit', ['a'])])
    ]
    const known = knownFailures(runs, unit)
    expect(known).toHaveLength(1)
    expect(known[0]).toMatchObject({ command: 'Unit', test: 'a', failedRuns: 2, ofRuns: 2, intermittent: false })
  })

  it('counts only the runs that have a result for the command', () => {
    const runs = [run([result('Unit', ['a']), result('E2E', ['b'])]), run([result('Unit', [])])]
    const known = knownFailures(runs, [{ name: 'Unit' }, { name: 'E2E' }])
    expect(known.map((k) => [k.command, k.test, k.failedRuns, k.ofRuns])).toEqual([
      ['E2E', 'b', 1, 1],
      ['Unit', 'a', 1, 2]
    ])
  })

  it('records a command that failed without naming a test as a whole-command failure, and a timeout too', () => {
    const known = knownFailures([run([result('Unit', [], 2)]), run([result('Unit', [], null, true)])], unit)
    expect(known).toEqual([{ command: 'Unit', test: null, failedRuns: 2, ofRuns: 2, intermittent: false, inLatest: true, exitCode: 2 }])
  })

  it('ignores the whole-command key in a run that named its failures', () => {
    const known = knownFailures([run([result('Unit', ['a'], 1)]), run([result('Unit', [], 1)])], unit)
    expect(known.map((k) => [k.test, k.intermittent])).toEqual([
      [null, true],
      ['a', true]
    ])
  })
})

describe('baseTestsSummary', () => {
  it('is null when there are no test commands or no run', () => {
    expect(baseTestsSummary({ testCommands: [] }, [run([result('Unit', [])])])).toBeNull()
    expect(baseTestsSummary({ testCommands: [{ name: 'Unit', command: 'x', format: 'plain' }] }, [])).toBeNull()
  })

  it('describes the latest run and its known failures', () => {
    const summary = baseTestsSummary({ testCommands: [{ name: 'Unit', command: 'x', format: 'plain' }] }, [run([result('Unit', ['a', 'b'])])])
    expect(summary).toMatchObject({
      baseRef: 'origin/main',
      at: '2026-11-07T10:05:00.000Z',
      error: null,
      commands: [{ name: 'Unit', exitCode: 1, timedOut: false, failing: 2 }]
    })
    expect(summary!.knownFailures.map((k) => k.test)).toEqual(['a', 'b'])
  })
})
