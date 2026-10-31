import type { AgentEvent } from '../../shared/events'

/** A usage limit an agent ran into. */
export interface UsageLimit {
  /** When it resets (milliseconds since the epoch), when the SDK said. */
  resetsAt: number | null
}

/**
 * The limit a `rate_limit` event reports, or null when requests are still allowed. The SDK sends
 * `status: 'rejected'` with `resetsAt` in Unix seconds; failing that, a rejected window's reset time is used.
 */
export function limitFromEvent(e: Extract<AgentEvent, { kind: 'rate_limit' }>): UsageLimit | null {
  if (e.status !== 'rejected') return null
  const windows = Object.values(e.windows).filter((w) => w.status === 'rejected')
  const seconds = e.resetsAt ?? (windows.length > 0 ? Math.max(...windows.map((w) => w.resetsAt)) : null)
  return { resetsAt: seconds === null ? null : seconds * 1000 }
}

// The CLI's own wording: "You've hit your limit · resets 3pm", "Claude AI usage limit reached", "rate limited".
const LIMIT_TEXT = /usage limit|hit your (?:\S+ )?limit|limit reached|rate.?limit/i

/** True when a failed turn's error text says a usage limit stopped it. */
export function isUsageLimitText(text: string | undefined): boolean {
  return text !== undefined && LIMIT_TEXT.test(text)
}
