// Shared by the engine and the renderer: pure functions only, no Node imports.
import type { ModelUsage, StoredEvent, ThreadEvent, ThreadRun, TokenCounts, UsageEvent } from './events'

export const COST_LABEL = 'API-equivalent cost, not billed on your Claude plan'
export const NOT_RECORDED = 'Not recorded'

/** What some usage events add up to. `turns` and `agentMs` count agent turns only, not Mainbus's own calls. */
export interface UsageTotals extends TokenCounts {
  turns: number
  agentMs: number
  /** null when no event had a cost estimate. */
  costUsd: number | null
  models: string[]
}

export interface RoleUsage {
  role: string
  /** null: not recorded. */
  usage: UsageTotals | null
}

export interface RunUsage {
  ticketRunId: string
  /** Run 1, 2, ... in the order the runs were given. */
  n: number
  roles: RoleUsage[]
  /** Mainbus's own calls for this run (skip and replace summaries, promote drafts); null when there were none. */
  mainbus: UsageTotals | null
  usage: UsageTotals | null
}

export interface TicketUsage {
  total: UsageTotals | null
  runs: RunUsage[]
}

function emptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, agentMs: 0, costUsd: null, models: [] }
}

function addUsage(t: UsageTotals, u: UsageEvent): void {
  t.inputTokens += u.inputTokens
  t.outputTokens += u.outputTokens
  t.cacheReadTokens += u.cacheReadTokens
  t.cacheWriteTokens += u.cacheWriteTokens
  if (u.costUsd !== undefined) t.costUsd = (t.costUsd ?? 0) + u.costUsd
  if (u.call === undefined) {
    t.turns += 1
    t.agentMs += u.durationMs
  }
  for (const m of Object.keys(u.models)) if (!t.models.includes(m)) t.models.push(m)
}

function totalsOf(events: UsageEvent[]): UsageTotals | null {
  if (events.length === 0) return null
  const t = emptyTotals()
  for (const u of events) addUsage(t, u)
  return t
}

function isUsage(e: ThreadEvent): e is UsageEvent {
  return e.kind === 'usage'
}

/** Usage by ticket run and role. A run or role with no usage events has `null`: "Not recorded", never zero. */
export function ticketUsage(events: StoredEvent[], runs: ThreadRun[] | Record<string, ThreadRun>): TicketUsage {
  const list = Array.isArray(runs) ? runs : Object.values(runs)
  const byRun = new Map<string, ThreadRun>(list.map((r) => [r.id, r]))
  const order: string[] = []
  const groups = new Map<string, { roles: Map<string, UsageEvent[]>; mainbus: UsageEvent[]; all: UsageEvent[] }>()
  for (const r of list) {
    if (groups.has(r.ticketRunId)) continue
    order.push(r.ticketRunId)
    groups.set(r.ticketRunId, { roles: new Map(), mainbus: [], all: [] })
  }
  // Roles come in the order they appear among the runs, so one that has no usage still shows.
  for (const r of list) {
    const g = groups.get(r.ticketRunId)!
    if (!g.roles.has(r.role)) g.roles.set(r.role, [])
  }
  const all: UsageEvent[] = []
  for (const e of events) {
    if (!isUsage(e.event)) continue
    const run = byRun.get(e.runId)
    if (!run) continue
    const g = groups.get(run.ticketRunId)!
    g.all.push(e.event)
    all.push(e.event)
    if (e.event.call !== undefined) g.mainbus.push(e.event)
    else g.roles.get(run.role)!.push(e.event)
  }
  return {
    total: totalsOf(all),
    runs: order.map((ticketRunId, i) => {
      const g = groups.get(ticketRunId)!
      return {
        ticketRunId,
        n: i + 1,
        roles: [...g.roles].map(([role, us]) => ({ role, usage: totalsOf(us) })),
        mainbus: totalsOf(g.mainbus),
        usage: totalsOf(g.all)
      }
    })
  }
}

/** The orchestrator's totals over all its events; null when none were recorded. */
export function orchestratorUsage(events: StoredEvent[]): UsageTotals | null {
  return totalsOf(events.map((e) => e.event).filter(isUsage))
}

/**
 * What the session `sessionId` had used per model, from one run's events in order. The SDK's own totals carry over when a
 * session is resumed, so a resumed process starts from this. Mainbus's own calls are no part of a session.
 */
export function sessionUsageSoFar(events: ThreadEvent[], sessionId: string): Record<string, ModelUsage> {
  const out: Record<string, ModelUsage> = {}
  let current: string | null = null
  for (const e of events) {
    if (e.kind === 'session') current = e.sessionId
    else if (e.kind === 'usage' && e.call === undefined && current === sessionId) {
      for (const [name, m] of Object.entries(e.models)) {
        const o = out[name] ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }
        out[name] = {
          inputTokens: o.inputTokens + m.inputTokens,
          outputTokens: o.outputTokens + m.outputTokens,
          cacheReadTokens: o.cacheReadTokens + m.cacheReadTokens,
          cacheWriteTokens: o.cacheWriteTokens + m.cacheWriteTokens,
          costUsd: o.costUsd + m.costUsd
        }
      }
    }
  }
  return out
}

/** 950, 12.3k, 1.2M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** 45s, 12m, 1h 05m. */
export function formatAgentTime(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** $0.42, or "under $0.01" for less; "n/a" when the SDK gave no estimate. */
export function formatCost(usd: number | null): string {
  if (usd === null) return 'n/a'
  if (usd > 0 && usd < 0.01) return 'under $0.01'
  return `$${usd.toFixed(2)}`
}

/** One plain line for the orchestrator: tokens, turns, agent time and the cost, labelled as API-equivalent. */
export function usageLine(u: UsageTotals): string {
  const tokens = `${formatTokens(u.inputTokens)} input, ${formatTokens(u.outputTokens)} output, ${formatTokens(u.cacheReadTokens)} cache read, ${formatTokens(u.cacheWriteTokens)} cache write tokens`
  const turns = u.turns > 0 ? `; ${u.turns} ${u.turns === 1 ? 'turn' : 'turns'}, ${formatAgentTime(u.agentMs)} of agent time` : ''
  const cost = u.costUsd === null ? '' : `; API-equivalent cost ${formatCost(u.costUsd)}, not billed on the user's Claude plan`
  return tokens + turns + cost
}
