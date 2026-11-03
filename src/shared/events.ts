// Shared by the engine and the renderer: types only, no Node imports.
import type { AgentStatus, StuckRule } from './domain'
import type { Proposal } from './proposals'

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
   * to; it is absent when the last role hands off, and on handoffs recorded before it was kept. `skipped` marks
   * the handoff of a role the user skipped: Mainbus wrote its summary, from a model call or as a digest.
   */
  | {
      kind: 'handoff'
      summary: string
      outcome: 'done' | 'hand_back' | 'ask'
      notesForNext?: string
      to?: string
      skipped?: { by: 'user'; source: 'summary' | 'digest' }
    }
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
  /** Mainbus started an orchestrator turn itself, for these items (one plain line each): failures, stuck agents, released holds, decisions that came back. */
  | { kind: 'wake'; items: string[] }
  /** Mainbus pushed the ticket's branch; `opened` when it opened (or adopted) the pull request this time. */
  | { kind: 'pull_request'; branch: string; number: number; url: string; opened: boolean }
  /** The run's role submitted its report (Investigate tickets); the ticket view shows it where the final message would be. */
  | { kind: 'report'; markdown: string }
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
  /** The user paused the run's role: its process stopped, and the run stays open until Resume. */
  | { kind: 'paused' }
  /** The user's pause ended: Resume, or a message or answer that resumed the role. */
  | { kind: 'resumed' }
  /** The user confirmed the orchestrator's redirect of the run's role: its turn was interrupted and `text` sent as its next message. */
  | { kind: 'redirected'; role: string; text: string; proposalId?: string }
  /** The user replaced the run's role: this run ended, and `summary` (generated from its log, or the digest) goes to its successor. */
  | {
      kind: 'replaced'
      role: string
      summary: string
      source: 'summary' | 'digest'
      proposalId?: string
      /** Who proposed it: the orchestrator, or the user with the Replace… button. Absent on replacements recorded before it was kept. */
      suggestedBy?: 'orchestrator' | 'user'
    }
  /**
   * The stuck detector's news about the run's role: an episode `opened`, `escalated` to needing a closer look, or
   * `fired_again` after the redirect. `count` is how many times the same command failed, for repeated_failure.
   */
  | { kind: 'stuck'; role: string; change: 'opened' | 'escalated' | 'fired_again'; episodeId: string; rule: StuckRule; evidence: string[]; count?: number }
  /** The run's role got stuck again after being replaced as often as allowed: Mainbus marked it Failed. An error event follows. */
  | { kind: 'stuck_failed'; role: string; replacements: number }
  /** The run's role declared a wait with report_waiting: the stuck detector expects silence until `until` (ISO). */
  | { kind: 'waiting'; reason: string; until: string }
  /** The orchestrator proposed something here; the panel shows the proposal's card in its place. */
  | { kind: 'proposal'; proposalId: string; from?: 'drag' | 'button' }
  /** The orchestrator created these tickets directly in the workspace's Backlog, at the user's request; the panel shows a receipt. */
  | { kind: 'tickets_created'; workspaceId: string; workspace: string; tickets: { id: string; number: number; title: string }[] }

export type StoredEvent = { runId: string; seq: number; at: string; event: ThreadEvent }

/** What the orchestrator is doing: `failed` when its last turn failed or its process ended mid-turn. */
export type OrchestratorStatus = 'idle' | 'working' | 'failed'

/** One orchestrator session; a run ends only when it couldn't be resumed and a fresh one took over. */
export interface OrchestratorRun {
  id: string
  startedAt: string
  endedAt: string | null
  endReason: 'resume_failed' | null
}

/** The orchestrator's whole thread: every run, oldest first, their events, and every proposal it made. */
export interface OrchestratorThread {
  status: OrchestratorStatus
  runs: OrchestratorRun[]
  events: StoredEvent[]
  proposals: Proposal[]
}

/** The agent run a thread event belongs to: its ticket run and its role's name. */
export interface ThreadRun {
  id: string
  ticketRunId: string
  role: string
}
