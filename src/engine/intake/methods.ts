import path from 'node:path'
import { z } from 'zod'
import type { Column, NewTicketInput, Ticket, TicketState, Workspace } from '../../shared/domain'
import { nonBlank, singleLine, text, ticketFields } from '../tickets/validate'
import type {
  CreateParams,
  IntakeError,
  IntakeErrorCode,
  IntakeMethod,
  IntakeResults,
  IntakeStatus,
  IntakeTicketSummary
} from './protocol'

/** A failure the client should see as is: its code, message and field go into the error reply. */
export class IntakeFailure extends Error {
  constructor(
    readonly code: IntakeErrorCode,
    message: string,
    readonly field?: string
  ) {
    super(message)
    this.name = 'IntakeFailure'
  }

  toError(): IntakeError {
    return this.field === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, field: this.field }
  }
}

export type IntakeHandler = <M extends IntakeMethod>(method: M, params: unknown) => Promise<IntakeResults[M]>

export interface IntakeDeps {
  /** Every open workspace. */
  workspaces(): Promise<Workspace[]>
  /** The folder holding the workspace's ticket folders; agents work in one of them. */
  ticketFolders(ws: Workspace): string
  /** The same path as the ticket.create command: stores the ticket and emits board.changed. */
  createTicket(ws: Workspace, input: Omit<NewTicketInput, 'workspaceId'>): Promise<Ticket>
  tickets(ws: Workspace): Promise<(Ticket & { state: TicketState })[]>
  /** One ticket by number, or null; loads only that ticket. */
  ticket(ws: Workspace, number: number): Promise<(Ticket & { state: TicketState }) | null>
}

const COLUMNS = ['backlog', 'ready', 'in_progress', 'needs_you', 'review', 'done'] as const satisfies readonly Column[]

const createSchema = z.strictObject({
  title: ticketFields.title,
  intent: text(20_000).refine(nonBlank, 'must not be blank'),
  spec: ticketFields.spec.optional(),
  criteria: ticketFields.criteria.optional(),
  labels: ticketFields.labels.optional(),
  repo: text(1_000).optional(),
  source: z.strictObject({
    agent: text(100).refine(singleLine, 'must be a single line'),
    cwd: z.string().max(1_000, 'must be at most 1000 characters')
  })
}) satisfies z.ZodType<CreateParams>

const cwdField = z.string().max(1_000, 'must be at most 1000 characters')

const listSchema = z.strictObject({ cwd: cwdField, column: z.enum(COLUMNS).optional() })

const getSchema = z.strictObject({ cwd: cwdField, number: z.number().int().positive() })

function parse<T>(schema: z.ZodType<T>, params: unknown): T {
  const result = schema.safeParse(params)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  if (issue.code === 'unrecognized_keys') {
    const field = [...issue.path, issue.keys[0]].map(String).join('.')
    const why = field === 'column' ? ': tickets from agents always land in Backlog' : ''
    throw new IntakeFailure('invalid', `Unknown field: ${field}${why}`, field)
  }
  const field = issue.path.map(String).join('.') || 'params'
  throw new IntakeFailure('invalid', `${field}: ${issue.message}`, field)
}

/** True when `inner` is `outer` or a path inside it; case-insensitive on Windows. Both must be absolute. */
export function isInside(inner: string, outer: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix
  const fold = (s: string): string => (platform === 'win32' ? p.resolve(s).toLowerCase() : p.resolve(s))
  const rel = p.relative(fold(outer), fold(inner))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel))
}

function status(state: TicketState): IntakeStatus {
  return { column: state.column, phase: state.phase, agentStatus: state.agentStatus }
}

/**
 * The intake methods. Validation lives here, not in the clients. Tickets always land in Backlog,
 * and nothing returned ever includes thread events, decisions or allow rules.
 */
export function createIntakeHandler(deps: IntakeDeps): IntakeHandler {
  /**
   * The workspace the caller's folder belongs to: the one whose repo, or whose ticket folders, contain it. With nested
   * repos the deepest one wins. Nothing is guessed: no match is a refusal.
   */
  async function workspaceFor(folder: string, field: string): Promise<Workspace> {
    const all = await deps.workspaces()
    if (all.length === 0) throw new IntakeFailure('no_workspace', 'No workspace is open in Mainbus. Open one there first.')
    if (!path.isAbsolute(folder)) throw new IntakeFailure('invalid', `${field}: must be an absolute path`, field)
    let best: { ws: Workspace; depth: number } | null = null
    for (const ws of all) {
      for (const root of [ws.repoPath, deps.ticketFolders(ws)]) {
        if (!isInside(folder, root)) continue
        const depth = path.resolve(root).length
        if (best === null || depth > best.depth) best = { ws, depth }
      }
    }
    if (best === null) {
      throw new IntakeFailure(
        'workspace_mismatch',
        `${field}: ${folder} is not in any open workspace (${all.map((w) => w.repoPath).join(', ')})`,
        field
      )
    }
    return best.ws
  }

  async function byNumber(ws: Workspace, number: number): Promise<Ticket & { state: TicketState }> {
    const ticket = await deps.ticket(ws, number)
    if (!ticket) throw new IntakeFailure('not_found', `No ticket #${number} in ${ws.name}`, 'number')
    return ticket
  }

  const methods: { [M in IntakeMethod]: (params: unknown) => Promise<IntakeResults[M]> } = {
    async create(params) {
      const p = parse(createSchema, params)
      const ws = p.repo !== undefined ? await workspaceFor(p.repo, 'repo') : await workspaceFor(p.source.cwd, 'source.cwd')
      const ticket = await deps.createTicket(ws, {
        title: p.title,
        intent: p.intent,
        spec: p.spec ?? '',
        criteria: p.criteria ?? [],
        labels: p.labels ?? [],
        column: 'backlog',
        source: { kind: 'agent', agent: p.source.agent, cwd: p.source.cwd }
      })
      return { number: ticket.number, title: ticket.title, column: 'backlog' }
    },

    async list(params) {
      const p = parse(listSchema, params)
      const ws = await workspaceFor(p.cwd, 'cwd')
      const tickets: IntakeTicketSummary[] = (await deps.tickets(ws))
        .filter((t) => p.column === undefined || t.state.column === p.column)
        .map((t) => ({
          number: t.number,
          title: t.title,
          ...status(t.state),
          labels: t.labels,
          source: t.intent[0]?.source ?? null,
          prUrl: t.pr?.url ?? null,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt
        }))
      return { tickets }
    },

    async get(params) {
      const p = parse(getSchema, params)
      const t = await byNumber(await workspaceFor(p.cwd, 'cwd'), p.number)
      return {
        number: t.number,
        title: t.title,
        ...status(t.state),
        intent: t.intent.map((e) => ({ text: e.text, at: e.at, source: e.source ?? null })),
        spec: t.spec,
        criteria: t.criteria.map((c) => ({ text: c.text, checked: c.checked })),
        labels: t.labels,
        prUrl: t.pr?.url ?? null,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt
      }
    }
  }

  return (method, params) => {
    if (!Object.hasOwn(methods, method)) {
      return Promise.reject(new IntakeFailure('unknown_method', `Unknown method: ${String(method)}`))
    }
    return methods[method](params) as Promise<IntakeResults[typeof method]>
  }
}
