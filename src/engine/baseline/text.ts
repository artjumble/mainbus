import type { BaseTestsSummary, KnownFailure } from '../../shared/domain'
import { data, oneLine } from '../roles/prompt'

/** At most this many known failures are listed; the rest are counted. */
export const KNOWN_FAILURES_CAP = 30
const NAME_MAX = 300

function clip(text: string): string {
  const one = oneLine(text)
  return one.length > NAME_MAX ? `${one.slice(0, NAME_MAX)}…` : one
}

/** `2026-11-07 16:57 UTC` */
export function utcMinute(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? oneLine(iso) : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function failureLine(f: KnownFailure, latestUsable: boolean): string {
  const what = f.test === null ? `${clip(f.command)}: the command failed (exit code ${f.exitCode ?? 'none'}) and named no failing test` : `${clip(f.command)}: ${clip(f.test)}`
  const notes: string[] = []
  if (f.intermittent) notes.push(`intermittent, ${f.failedRuns} of ${f.ofRuns} runs`)
  else if (f.ofRuns > 1) notes.push(`failed in all ${f.ofRuns} runs`)
  const suffix = notes.length > 0 ? ` (${notes.join('; ')})` : ''
  const fixed = latestUsable && !f.inLatest ? '; passed in the latest run' : ''
  return `- ${what}${suffix}${fixed}`
}

/**
 * What is known about the base branch's tests, as plain lines of data: the known failures with their intermittent
 * marks, "All passed", or why the latest run couldn't run the tests. Names are one line each and clipped.
 */
export function knownFailuresText(summary: BaseTestsSummary): string {
  const base = data('base', clip(summary.baseRef), true)
  const where = `${base} at ${summary.baseSha.slice(0, 7)} (${utcMinute(summary.at)})`
  const lines: string[] = []
  if (summary.error !== null) lines.push(`Mainbus couldn't run the tests on ${where}: ${clip(summary.error)}`)
  if (summary.knownFailures.length === 0) {
    if (summary.error === null) lines.push(`All passed on ${where}.`)
    return lines.join('\n')
  }
  const shown = summary.knownFailures.slice(0, KNOWN_FAILURES_CAP).map((f) => failureLine(f, summary.error === null))
  const more = summary.knownFailures.length - KNOWN_FAILURES_CAP
  if (more > 0) shown.push(`…and ${more} more`)
  lines.push(`Known failures on ${where}:`, data('known-failures', shown.join('\n')))
  return lines.join('\n')
}
