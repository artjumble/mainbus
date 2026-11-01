// The intake protocol between the running app and the `mainbus` CLI / MCP server: newline-delimited JSON
// over a named pipe (a unix socket off Windows). Types and constants only, so the CLI bundle can share it.
import type { AgentStatus, Column, IntentSource, Phase } from '../../shared/domain'

export const INTAKE_VERSION = 1

/**
 * A request line longer than this (in bytes, without its newline) gets a too_large error and the connection closes.
 * The largest valid create has about 173,300 UTF-16 units of text, and JSON escaping turns a unit into at most
 * 6 bytes (`\u0001`), so it needs about 1.04 MB; 2 MiB leaves room for any client's escaping and spacing.
 */
export const MAX_LINE_BYTES = 2 * 1024 * 1024

export const INTAKE_METHODS = ['create', 'list', 'get'] as const
export type IntakeMethod = (typeof INTAKE_METHODS)[number]

export type RequestId = string | number

export interface IntakeRequest {
  v: typeof INTAKE_VERSION
  id: RequestId
  method: string
  params?: unknown
}

/** parse_error, bad_request, unknown_method and too_large also end the connection after the reply. */
export type IntakeErrorCode =
  | 'invalid'
  | 'workspace_mismatch'
  | 'no_workspace'
  | 'not_found'
  | 'parse_error'
  | 'bad_request'
  | 'unknown_method'
  | 'too_large'
  | 'internal'

export interface IntakeError {
  code: IntakeErrorCode
  message: string
  /** The offending field, dotted for nested ones (`source.agent`, `criteria.2`). */
  field?: string
}

/** id is null when the request could not be read far enough to find one. */
export type IntakeReply = { id: RequestId | null; result: unknown } | { id: RequestId | null; error: IntakeError }

export interface CreateParams {
  title: string
  intent: string
  spec?: string
  criteria?: string[]
  labels?: string[]
  /** Absolute path; must be the open workspace's repo or a folder inside it. Omitted means the open workspace. */
  repo?: string
  source: { agent: string; cwd: string }
}

export interface ListParams {
  column?: Column
}

export interface GetParams {
  number: number
}

/** Where a ticket is and what its agent is doing. Never a decision's question or a failure message. */
export interface IntakeStatus {
  column: Column
  phase: Phase
  agentStatus: AgentStatus | null
}

export interface IntakeTicketSummary extends IntakeStatus {
  number: number
  title: string
  labels: string[]
  /** Who filed the ticket, when an agent did; null for the user's own tickets. */
  source: IntentSource | null
  /** The ticket's pull request, once Mainbus has opened one. */
  prUrl: string | null
  createdAt: string
  updatedAt: string
}

export interface IntakeTicketDetail extends IntakeStatus {
  number: number
  title: string
  intent: { text: string; at: string; source: IntentSource | null }[]
  spec: string
  criteria: { text: string; checked: boolean }[]
  labels: string[]
  /** The ticket's pull request, once Mainbus has opened one. */
  prUrl: string | null
  createdAt: string
  updatedAt: string
}

export interface IntakeResults {
  create: { number: number; title: string; column: 'backlog' }
  list: { tickets: IntakeTicketSummary[] }
  get: IntakeTicketDetail
}
