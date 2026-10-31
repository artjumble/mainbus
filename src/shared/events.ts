// Shared by the engine and the renderer: types only, no Node imports.
import type { AgentStatus } from './domain'

/** What an agent asks the user; the engine turns it into a stored Decision. */
export interface DecisionDraft {
  question: string
  options: string[]
  recommended?: number
}

/** Events emitted by an agent runtime (spec section 7, plus M1 additions). */
export type AgentEvent =
  | { kind: 'message'; text: string; partial?: boolean }
  | { kind: 'thinking'; text: string | null; durationMs?: number; partial?: boolean }
  | { kind: 'tool_call'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; ok: boolean; summary: string }
  | { kind: 'status'; status: AgentStatus; detail?: string }
  | { kind: 'needs_input'; decision: DecisionDraft }
  | { kind: 'handoff'; summary: string; outcome: 'done' | 'hand_back' | 'ask' }
  | { kind: 'usage'; inputTokens: number; outputTokens: number } // stored, never shown on cards
  | { kind: 'error'; message: string }
  | { kind: 'turn_end'; ok: boolean; interrupted?: boolean; error?: string }
  | { kind: 'session'; sessionId: string }
  | {
      kind: 'rate_limit'
      status: string
      windows: Record<string, { utilization: number; resetsAt: number; status: string }>
    }
  | { kind: 'vcs_changed' }

/** Everything that can appear in a run's stored thread. */
export type ThreadEvent =
  | AgentEvent
  | { kind: 'user_message'; text: string }
  | { kind: 'decision'; decisionId: string }
  | { kind: 'nudge'; text: string }
  | { kind: 'process_exit'; code: number | null }
  | { kind: 'stopped' }

export type StoredEvent = { runId: string; seq: number; at: string; event: ThreadEvent }
