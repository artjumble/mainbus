import type { AgentEvent } from '../../shared/events'

type Json = Record<string, unknown>
type RateLimitWindows = Extract<AgentEvent, { kind: 'rate_limit' }>['windows']

const SUMMARY_MAX = 200

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toSummary(content: unknown): string {
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .filter((p): p is Json => isRecord(p) && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n')
  }
  return text.length > SUMMARY_MAX ? text.slice(0, SUMMARY_MAX) : text
}

function windowsOf(info: Json): RateLimitWindows {
  const windows: RateLimitWindows = {}
  if (!isRecord(info.unifiedWindows)) return windows
  for (const [name, w] of Object.entries(info.unifiedWindows)) {
    if (!isRecord(w) || typeof w.utilization !== 'number' || typeof w.resetsAt !== 'number') continue
    windows[name] = {
      utilization: w.utilization,
      resetsAt: w.resetsAt,
      status: typeof w.status === 'string' ? w.status : 'unknown'
    }
  }
  return windows
}

/**
 * Turns the Claude Agent SDK's message stream into Mainbus AgentEvents.
 * Stateful, so use one instance per run. It takes `unknown` and narrows structurally;
 * anything it does not recognise maps to no events.
 */
export class Normalizer {
  private readonly sessions = new Set<string>()
  private readonly textSoFar = new Map<string, string>()
  private readonly thinking = new Map<string, { startedAt: number; text: string }>()
  private messageId = ''
  private interruptExpected = false

  constructor(private readonly now: () => number = Date.now) {}

  /** The next `result` with `error_during_execution` counts as interrupted, not failed. */
  expectInterrupt(): void {
    this.interruptExpected = true
  }

  push(msg: unknown): AgentEvent[] {
    if (!isRecord(msg)) return []
    switch (msg.type) {
      case 'system':
        return this.system(msg)
      case 'assistant':
        return this.assistant(msg)
      case 'user':
        return this.user(msg)
      case 'stream_event':
        return this.stream(msg)
      case 'rate_limit_event':
        return this.rateLimit(msg)
      case 'result':
        return this.result(msg)
      default:
        return []
    }
  }

  private system(msg: Json): AgentEvent[] {
    if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
      if (this.sessions.has(msg.session_id)) return []
      this.sessions.add(msg.session_id)
      return [{ kind: 'session', sessionId: msg.session_id }]
    }
    if (msg.subtype === 'vcs_state_changed') return [{ kind: 'vcs_changed' }]
    return []
  }

  private blocks(msg: Json): Json[] {
    const message = msg.message
    if (!isRecord(message) || !Array.isArray(message.content)) return []
    return message.content.filter(isRecord)
  }

  private assistant(msg: Json): AgentEvent[] {
    const out: AgentEvent[] = []
    for (const block of this.blocks(msg)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        if (block.text !== '') out.push({ kind: 'message', text: block.text })
      } else if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        out.push({ kind: 'tool_call', id: block.id, name: block.name, input: block.input })
      }
      // Thinking blocks are reported from the stream events (start and stop), not here.
    }
    return out
  }

  private user(msg: Json): AgentEvent[] {
    const out: AgentEvent[] = []
    for (const block of this.blocks(msg)) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        out.push({
          kind: 'tool_result',
          id: block.tool_use_id,
          ok: block.is_error !== true,
          summary: toSummary(block.content)
        })
      }
    }
    return out
  }

  private stream(msg: Json): AgentEvent[] {
    const ev = msg.event
    if (!isRecord(ev)) return []
    const key = `${this.messageId}:${typeof ev.index === 'number' ? ev.index : ''}`
    switch (ev.type) {
      case 'message_start':
        if (isRecord(ev.message) && typeof ev.message.id === 'string') this.messageId = ev.message.id
        return []
      case 'message_stop':
        this.textSoFar.clear()
        this.thinking.clear()
        return []
      case 'content_block_start': {
        const block = ev.content_block
        if (!isRecord(block)) return []
        if (block.type === 'thinking') {
          this.thinking.set(key, { startedAt: this.now(), text: '' })
          return [{ kind: 'thinking', text: null, partial: true }]
        }
        if (block.type === 'text') this.textSoFar.set(key, '')
        return []
      }
      case 'content_block_delta': {
        const delta = ev.delta
        if (!isRecord(delta)) return []
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          const text = (this.textSoFar.get(key) ?? '') + delta.text
          this.textSoFar.set(key, text)
          return [{ kind: 'message', text, partial: true }]
        }
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          const t = this.thinking.get(key)
          if (t) t.text += delta.thinking
        }
        return []
      }
      case 'content_block_stop': {
        const t = this.thinking.get(key)
        if (!t) return []
        this.thinking.delete(key)
        return [
          {
            kind: 'thinking',
            text: t.text === '' ? null : t.text,
            durationMs: Math.max(0, this.now() - t.startedAt)
          }
        ]
      }
      default:
        return []
    }
  }

  private rateLimit(msg: Json): AgentEvent[] {
    const info = msg.rate_limit_info
    if (!isRecord(info) || typeof info.status !== 'string') return []
    return [
      {
        kind: 'rate_limit',
        status: info.status,
        ...(typeof info.resetsAt === 'number' ? { resetsAt: info.resetsAt } : {}),
        windows: windowsOf(info)
      }
    ]
  }

  private result(msg: Json): AgentEvent[] {
    const interruptExpected = this.interruptExpected
    this.interruptExpected = false
    const subtype = typeof msg.subtype === 'string' ? msg.subtype : 'unknown'
    // A `success` can still carry an API error (usage limit, overload after retries, expired login).
    if (subtype === 'success' && msg.is_error !== true) return [{ kind: 'turn_end', ok: true }]
    if (subtype === 'error_during_execution' && interruptExpected) {
      return [{ kind: 'turn_end', ok: false, interrupted: true }]
    }
    const errors = Array.isArray(msg.errors)
      ? msg.errors.filter((e): e is string => typeof e === 'string').join('\n')
      : ''
    const error = typeof msg.result === 'string' && msg.result !== '' ? msg.result : errors || subtype
    return [{ kind: 'turn_end', ok: false, error }]
  }
}
