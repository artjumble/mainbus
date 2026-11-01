import type { Decision } from '../../shared/domain'
import type { StoredEvent, ThreadEvent } from '../../shared/events'
import { data } from '../roles/prompt'

const DIGEST_EVENTS = 20
const DIGEST_LINE_MAX = 200

/** One line, whitespace collapsed, at most DIGEST_LINE_MAX characters. */
function digestLine(text: string): string {
  const flat = text.split(/\s+/).filter(Boolean).join(' ')
  return flat.length <= DIGEST_LINE_MAX ? flat : `${flat.slice(0, DIGEST_LINE_MAX - 1)}…`
}

const CHOICES = { allow_once: 'Allowed once', always_allow: 'Always allowed', deny: 'Denied' } as const

/** What the user chose, in words, or why there is no answer. */
function outcome(d: Decision): string {
  if (d.status !== 'answered' || d.answer === null) return d.status === 'pending' ? 'not answered yet' : `no answer (${d.status})`
  const a = d.answer
  const chosen = a.kind === 'option' ? (d.options[a.index] ?? `option ${a.index + 1}`) : CHOICES[a.choice]
  return a.note ? `${chosen} (note: ${a.note})` : chosen
}

/** A plain-text line for a thread event, or null for events that say nothing about the work. */
function describe(event: ThreadEvent, decisions: Map<string, Decision>, roleName: string): string | null {
  switch (event.kind) {
    case 'message':
      return `${roleName}: ${event.text}`
    case 'tool_call':
      return `Tool call: ${event.name} ${JSON.stringify(event.input) ?? ''}`
    case 'tool_result':
      return `Tool result (${event.ok ? 'ok' : 'failed'}): ${event.summary}`
    case 'user_message':
      return `User: ${event.text}`
    case 'nudge':
    case 'notice':
      return `Mainbus: ${event.text}`
    case 'handoff':
      return `Handoff: ${event.summary}`
    case 'hand_back':
      return `${event.from} handed back to ${event.to}: ${event.details}`
    case 'role_hand_back':
      return `${event.from} handed the ticket back to ${event.to}`
    case 'criterion_checked':
      return `${roleName} checked: ${event.text}`
    case 'error':
      return `Error: ${event.message}`
    case 'turn_end':
      return event.ok || event.interrupted ? null : `Turn failed: ${event.error ?? 'unknown error'}`
    case 'decision': {
      const d = decisions.get(event.decisionId)
      return d ? `Asked the user: ${d.question} → ${outcome(d)}` : null
    }
    default:
      return null
  }
}

/** The resume-fallback prompt: an engine-built digest of the last thread events (no model call in M1). */
export function previousAttempt(events: StoredEvent[], decisions: Decision[], roleName: string): string {
  const byId = new Map(decisions.map((d) => [d.id, d]))
  const lines = events
    .map((e) => describe(e.event, byId, roleName))
    .filter((line): line is string => line !== null)
    .slice(-DIGEST_EVENTS)
    .map(digestLine)
  return `Handoff from the previous attempt:\n${data('previous-attempt', lines.join('\n'))}`
}
