import type { BaseTestCommandResult, BaseTestsSummary, KnownFailure, TestCommand, Workspace } from '../../shared/domain'
import type { BaseTestRun } from '../store/baseTests'

/** A whole command that failed without naming a failing test is counted under this key. */
const WHOLE = '\u0000command'

function commandFailed(r: BaseTestCommandResult): boolean {
  return r.timedOut || r.exitCode !== 0
}

/** The keys that failed in one command result: its named tests, or the whole command when it failed and named none. */
function failedKeys(r: BaseTestCommandResult): string[] {
  if (r.failures.length > 0) return r.failures
  return commandFailed(r) ? [WHOLE] : []
}

/**
 * The failures known on the base branch, from the recorded runs (newest first). Runs that could not run the commands and
 * commands no longer configured are ignored. For each command the runs counted are those that have a result for it.
 * Lists every test that failed in the latest run, and every test that failed in some runs and passed in others.
 */
export function knownFailures(runs: BaseTestRun[], commands: Pick<TestCommand, 'name'>[]): KnownFailure[] {
  const usable = runs.filter((r) => r.error === null)
  const known: KnownFailure[] = []
  for (const command of commands) {
    const perRun = usable
      .map((run) => run.results.find((r) => r.name === command.name))
      .filter((r): r is BaseTestCommandResult => r !== undefined)
    if (perRun.length === 0) continue
    const counts = new Map<string, number>()
    for (const r of perRun) for (const key of new Set(failedKeys(r))) counts.set(key, (counts.get(key) ?? 0) + 1)
    const latest = new Set(failedKeys(perRun[0]!))
    const ofRuns = perRun.length
    for (const [key, failedRuns] of counts) {
      const intermittent = failedRuns < ofRuns
      const inLatest = latest.has(key)
      if (!inLatest && !intermittent) continue
      const failing = perRun.find((r) => failedKeys(r).includes(key))
      known.push({
        command: command.name,
        test: key === WHOLE ? null : key,
        failedRuns,
        ofRuns,
        intermittent,
        inLatest,
        exitCode: failing?.exitCode ?? null
      })
    }
  }
  return known.sort((a, b) => a.command.localeCompare(b.command) || (a.test ?? '').localeCompare(b.test ?? ''))
}

/**
 * What the latest run found, with the known failures; null when the workspace has no test commands or no run has finished.
 * `runs` are the workspace's runs, newest first.
 */
export function baseTestsSummary(ws: Pick<Workspace, 'testCommands'>, runs: BaseTestRun[]): BaseTestsSummary | null {
  const latest = runs[0]
  if (ws.testCommands.length === 0 || !latest) return null
  return {
    baseRef: latest.baseRef,
    baseSha: latest.baseSha,
    at: latest.endedAt,
    error: latest.error,
    commands: latest.results.map((r) => ({
      name: r.name,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      failing: r.failures.length > 0 ? r.failures.length : commandFailed(r) ? 1 : 0
    })),
    knownFailures: knownFailures(runs, ws.testCommands)
  }
}
