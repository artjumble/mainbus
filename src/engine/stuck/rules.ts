import type { StoredEvent } from '../../shared/events'
import { clip } from '../orchestrator/readTools'
import { oneLine } from '../roles/prompt'
import type { StuckHit } from '../store/stuck'
import { STUCK } from './config'
import { inputText, normalizeCommand } from './normalize'

/** What the rules read about one run that is working. Times are ms since the epoch. */
export interface RuleInput {
  now: number
  /** The run's stored thread. */
  events: StoredEvent[]
  /** The last event of any kind, including streaming previews; or the last input or launch if later. */
  lastActivityAt: number
  /** When the agent's process was launched. */
  startedAt: number
  /** When the turn under way began: the last launch, message, answer or nudge. */
  turnStartedAt: number
  /** True until the turn ends. */
  inTurn: boolean
  /** The end of the wait the agent declared, once it has passed (then silence is counted from there); null for none. */
  waitEndedAt: number | null
  /** The newest file change in the worktree, or null when there is none or it isn't known. */
  filesChangedAt: number | null
}

const EVIDENCE_MAX = 200

const minutes = (ms: number): number => Math.floor(ms / 60_000)

/** The first time each kind of tool was called in the run, by tool name. */
export function toolKindsSeen(events: StoredEvent[]): Map<string, number> {
  const seen = new Map<string, number>()
  for (const { at, event } of events) {
    if (event.kind === 'tool_call' && !seen.has(event.name)) seen.set(event.name, Date.parse(at))
  }
  return seen
}

/** The same normalized command failing `count` times in a row, ending at the latest tool result. */
export function repeatedFailure(events: StoredEvent[], count: number = STUCK.repeatedFailures): StuckHit | null {
  const calls = new Map<string, { name: string; text: string }>()
  type Streak = { key: string; name: string; text: string; failures: number; error: string }
  let streak = null as Streak | null
  for (const { event } of events) {
    if (event.kind === 'tool_call') {
      calls.set(event.id, { name: event.name, text: inputText(event.input) })
    } else if (event.kind === 'tool_result') {
      const call = calls.get(event.id)
      if (event.ok || !call) {
        streak = null
        continue
      }
      const key = `${call.name}: ${normalizeCommand(call.text)}`
      streak = streak?.key === key ? { ...streak, failures: streak.failures + 1, error: event.summary } : { key, ...call, failures: 1, error: event.summary }
    }
  }
  if (!streak || streak.failures < count) return null
  return {
    rule: 'repeated_failure',
    count: streak.failures,
    evidence: [
      `${streak.name} failed ${streak.failures} times in a row: ${clip(oneLine(streak.text), EVIDENCE_MAX)}`,
      `Last error: ${clip(oneLine(streak.error), EVIDENCE_MAX)}`
    ]
  }
}

/** No file changes in the worktree and no new kind of tool for `noProgressMs`. */
export function noProgress(i: RuleInput): StuckHit | null {
  const seen = toolKindsSeen(i.events)
  const since = Math.max(i.startedAt, i.turnStartedAt, i.waitEndedAt ?? 0, i.filesChangedAt ?? 0, ...seen.values())
  if (i.now - since < STUCK.noProgressMs) return null
  const tools = [...seen.keys()].join(', ')
  return {
    rule: 'no_progress',
    evidence: [`No file changed in the worktree and no new kind of tool was used for ${minutes(i.now - since)} minutes`, ...(tools ? [`Tools used so far: ${tools}`] : [])]
  }
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
const MAX_COMMAND_TIMEOUT_MS = 1_800_000

/** True while a shell call is still waiting for its result and its timeout has not run out. */
function commandRunning(i: RuleInput): boolean {
  const open = new Map<string, number>()
  for (const { at, event } of i.events) {
    if (event.kind === 'tool_call' && (event.name === 'Bash' || event.name === 'PowerShell')) {
      const given = (event.input as { timeout?: unknown } | null)?.timeout
      const timeout = typeof given === 'number' && given > 0 ? Math.min(given, MAX_COMMAND_TIMEOUT_MS) : DEFAULT_COMMAND_TIMEOUT_MS
      open.set(event.id, Date.parse(at) + timeout)
    } else if (event.kind === 'tool_result') {
      open.delete(event.id)
    }
  }
  return [...open.values()].some((deadline) => i.now < deadline)
}

/** No events at all for `silenceMs`, unless a command is still running within its timeout. */
export function silence(i: RuleInput): StuckHit | null {
  if (commandRunning(i)) return null
  const since = Math.max(i.lastActivityAt, i.waitEndedAt ?? 0)
  if (i.now - since < STUCK.silenceMs) return null
  return { rule: 'silence', evidence: [`No events from the agent for ${minutes(i.now - since)} minutes`] }
}

/** One turn running for longer than `longTurnMs`. */
export function longTurn(i: RuleInput): StuckHit | null {
  if (!i.inTurn || i.now - i.turnStartedAt < STUCK.longTurnMs) return null
  return { rule: 'long_turn', evidence: [`The current turn has been running for ${minutes(i.now - i.turnStartedAt)} minutes`] }
}

/** The first rule that fires, or null. */
export function evaluate(i: RuleInput): StuckHit | null {
  return repeatedFailure(i.events) ?? noProgress(i) ?? silence(i) ?? longTurn(i)
}
