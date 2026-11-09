import type { AgentEvent, ModelUsage, UsageEvent } from '../../shared/events'

type Json = Record<string, unknown>
type RateLimitWindows = Extract<AgentEvent, { kind: 'rate_limit' }>['windows']

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function modelUsageOf(raw: Json): ModelUsage {
  return {
    inputTokens: num(raw.inputTokens),
    outputTokens: num(raw.outputTokens),
    cacheReadTokens: num(raw.cacheReadInputTokens),
    cacheWriteTokens: num(raw.cacheCreationInputTokens),
    costUsd: num(raw.costUSD)
  }
}

function add(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: a.costUsd + b.costUsd
  }
}

function subtract(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    inputTokens: a.inputTokens - b.inputTokens,
    outputTokens: a.outputTokens - b.outputTokens,
    cacheReadTokens: a.cacheReadTokens - b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens - b.cacheWriteTokens,
    costUsd: a.costUsd - b.costUsd
  }
}

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

  /** The session's running total per model so far. */
  private readonly usageSoFar: Record<string, ModelUsage>

  /** `usageBaseline`: what a resumed session had used before this process, since the SDK's totals carry over. */
  constructor(
    private readonly now: () => number = Date.now,
    usageBaseline: Record<string, ModelUsage> = {}
  ) {
    this.usageSoFar = { ...usageBaseline }
  }

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

  /**
   * What this turn used. `usage` and `duration_ms` are for the turn, but `modelUsage` and `total_cost_usd` are running
   * totals for the whole session (resumed sessions carry them over), so the turn is the difference from `usageSoFar`.
   */
  private usage(msg: Json): UsageEvent | null {
    const models: Record<string, ModelUsage> = {}
    if (isRecord(msg.modelUsage)) {
      for (const [name, raw] of Object.entries(msg.modelUsage)) {
        if (!isRecord(raw)) continue
        const total = modelUsageOf(raw)
        const before = this.usageSoFar[name]
        // A total that went down means the session's count started over: take it whole.
        const fresh = !before || (Object.keys(total) as (keyof ModelUsage)[]).some((k) => total[k] < before[k])
        models[name] = fresh ? total : subtract(total, before)
        this.usageSoFar[name] = total
      }
    }
    const durationMs = typeof msg.duration_ms === 'number' ? msg.duration_ms : 0
    const names = Object.keys(models)
    if (names.length > 0) {
      const sum = names.reduce<ModelUsage>((acc, n) => add(acc, models[n]), modelUsageOf({}))
      const { costUsd, ...tokens } = sum
      return { kind: 'usage', ...tokens, models, costUsd, durationMs }
    }
    if (!isRecord(msg.usage)) return null
    const u = msg.usage
    return {
      kind: 'usage',
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      cacheReadTokens: num(u.cache_read_input_tokens),
      cacheWriteTokens: num(u.cache_creation_input_tokens),
      models: {},
      durationMs
    }
  }

  private result(msg: Json): AgentEvent[] {
    const usage = this.usage(msg)
    // Usage comes first: the runner may stop the process on turn_end.
    return [...(usage ? [usage] : []), ...this.turnEnd(msg)]
  }

  private turnEnd(msg: Json): AgentEvent[] {
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
