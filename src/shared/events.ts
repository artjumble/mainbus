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
  /**
   * `notesForNext` is absent on handoffs recorded before lineups ran role after role. `to` names the role handed
   * to; it is absent when the last role hands off, and on handoffs recorded before it was kept.
   */
  | { kind: 'handoff'; summary: string; outcome: 'done' | 'hand_back' | 'ask'; notesForNext?: string; to?: string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number } // stored, never shown on cards
  | { kind: 'error'; message: string }
  | { kind: 'turn_end'; ok: boolean; interrupted?: boolean; error?: string }
  | { kind: 'session'; sessionId: string }
  | {
      kind: 'rate_limit'
      /** The SDK sends 'allowed', 'allowed_warning' or 'rejected'; 'rejected' means the usage limit is reached. */
      status: string
      /** When the limit that applies resets, in Unix seconds, when the SDK says. */
      resetsAt?: number
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
  /** Something Mainbus did on its own, such as unattended mode allowing a request. */
  | { kind: 'notice'; text: string }
  /** Mainbus pushed the ticket's branch; `opened` when it opened (or adopted) the pull request this time. */
  | { kind: 'pull_request'; branch: string; number: number; url: string; opened: boolean }
  /** The first event of a role's run when an earlier role of the same ticket run handed off to it. */
  | { kind: 'role_handoff'; from: string; to: string }
  /**
   * The last event of a role's run when it reported a problem and handed the ticket back to an earlier role.
   * The role ids are those of the ticket run's snapshot, since names need not be unique. `byUser` when the
   * user chose the hand-back (answering a decision); the round-trip cap counts from there.
   */
  | {
      kind: 'hand_back'
      from: string
      to: string
      fromRoleId: string
      toRoleId: string
      details: string
      byUser?: boolean
    }
  /** The first event of a role's run when a later role handed the ticket back to it. */
  | { kind: 'role_hand_back'; from: string; to: string }
  /** The run's role ticked the ticket's acceptance criterion at zero-based `index`. */
  | { kind: 'criterion_checked'; index: number; text: string }

export type StoredEvent = { runId: string; seq: number; at: string; event: ThreadEvent }

/** The agent run a thread event belongs to: its ticket run and its role's name. */
export interface ThreadRun {
  id: string
  ticketRunId: string
  role: string
}
