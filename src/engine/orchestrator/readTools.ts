import type { BoardTicket } from '../../shared/api'
import type { Column, Decision, Phase, RoleStatus, Workspace } from '../../shared/domain'
import type { StoredEvent, ThreadEvent } from '../../shared/events'
import { AGENT_FILED_SUFFIX, data, intentSections, oneLine } from '../roles/prompt'
import type { OrchestratorReadToolHandlers } from '../runtime/types'
import type { Repos } from '../store'

export interface ReadToolDeps {
  repos: Pick<Repos, 'runs' | 'decisions'>
  /** The open workspace, or null. */
  workspace(): Promise<Workspace | null>
  /** The workspace's tickets as the board shows them: state and lineup strip. */
  board(ws: Workspace): Promise<BoardTicket[]>
}

/** Agent messages, handoffs and the like are cut to this many characters. */
export const MESSAGE_MAX = 2000
/** A tool call is shown as its name and a summary of its input of at most this many characters. */
export const TOOL_SUMMARY_MAX = 120
export const EVENTS_DEFAULT = 20
export const EVENTS_MAX = 50

export const NO_WORKSPACE = 'No workspace is open.'

export const COLUMNS: Record<Column, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  needs_you: 'Needs you',
  review: 'Review',
  done: 'Done'
}

const PHASES: Record<Phase, string> = {
  not_started: 'not started',
  planning: 'planning',
  implementing: 'implementing',
  testing: 'testing',
  reviewing: 'reviewing',
  waiting_on_you: 'waiting on you',
  ready_for_review: 'ready for review',
  done: 'done'
}

const ROLE_STATUSES: Record<RoleStatus, string> = {
  not_started: 'not started',
  working: 'working',
  waiting_on_you: 'waiting on you',
  handed_off: 'handed off',
  paused: 'paused',
  failed: 'failed',
  stopped: 'stopped'
}

const PERMISSION_CHOICES = { allow_once: 'Allowed once', always_allow: 'Always allowed', deny: 'Denied' } as const

/** At most `max` characters, with "…" when cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function filedByAgent(t: BoardTicket): boolean {
  return t.intent[0]?.source !== undefined
}

function title(t: BoardTicket): string {
  return `#${t.number} ${data('title', oneLine(t.title), true)}`
}

/** " · held until 2026-11-04" for a held ticket, else nothing. */
function heldText(t: BoardTicket): string {
  if (!t.hold) return ''
  const until = t.hold.until === null ? 'until the user releases it' : `until ${t.hold.until.slice(0, 10)}`
  return ` · held by the user ${until} (don't propose starting it)`
}

function activeRole(t: BoardTicket): string {
  return t.lineup.find((r) => r.active)?.name ?? 'none'
}

function labels(t: BoardTicket): string {
  return t.labels.length ? data('labels', oneLine(t.labels.join(', ')), true) : 'none'
}

/** What a tool call was about, from its input: a path, a command or a pattern when it has one. */
function toolSummary(input: unknown): string {
  let text: string
  if (typeof input === 'object' && input !== null) {
    const i = input as Record<string, unknown>
    const key = ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query', 'description'].find(
      (k) => typeof i[k] === 'string' && i[k] !== ''
    )
    text = key !== undefined ? (i[key] as string) : (JSON.stringify(input) ?? '')
  } else {
    text = JSON.stringify(input) ?? ''
  }
  return clip(oneLine(text), TOOL_SUMMARY_MAX)
}

function answerText(d: Decision): string {
  if (d.status !== 'answered' || d.answer === null) return d.status === 'pending' ? 'not answered yet' : d.status
  const a = d.answer
  const chosen = a.kind === 'option' ? (d.options[a.index] ?? `option ${a.index + 1}`) : PERMISSION_CHOICES[a.choice]
  return `answered: ${data('answer', oneLine(a.note ? `${chosen} (note: ${a.note})` : chosen), true)}`
}

function localStamp(iso: string): string {
  const d = new Date(iso)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/** One line (or block) for a thread event, or null for events that say nothing to the orchestrator. */
function describe(e: ThreadEvent, role: string, decisions: Map<string, Decision>): string | null {
  const said = (field: string, text: string) => data(field, clip(text, MESSAGE_MAX))
  switch (e.kind) {
    case 'message':
      return e.partial ? null : `${role} said (agent-written):\n${said('message', e.text)}`
    case 'tool_call':
      return `${role} used ${oneLine(e.name)}: ${data('tool-input', toolSummary(e.input), true)}`
    case 'tool_result':
      return `Tool result: ${e.ok ? 'ok' : 'failed'}`
    case 'user_message':
      return `The user wrote in the ticket thread (the user's words):\n${said('user-message', e.text)}`
    case 'handoff': {
      const to = e.to ? ` to ${oneLine(e.to)}` : ''
      const by = e.skipped ? ` (the user skipped the ${role}; Mainbus wrote this summary)` : ' (agent-written)'
      const notes = e.notesForNext ? `\n${said('notes-for-next', e.notesForNext)}` : ''
      return `${role} handed off${to}${by}:\n${said('handoff-summary', e.summary)}${notes}`
    }
    case 'decision': {
      const d = decisions.get(e.decisionId)
      if (!d) return null
      return `${role} asked the user (${d.kind}): ${data('question', clip(oneLine(d.question), MESSAGE_MAX), true)} → ${answerText(d)}`
    }
    case 'nudge':
    case 'notice':
      return `Mainbus: ${said('notice', e.text)}`
    case 'error':
      return `Error: ${said('error', e.message)}`
    case 'turn_end':
      return e.ok || e.interrupted ? null : `${role}'s turn failed: ${data('error', clip(oneLine(e.error ?? 'unknown error'), MESSAGE_MAX), true)}`
    case 'process_exit':
      return `${role}'s process ended`
    case 'stopped':
      return `The user stopped the ${role}`
    case 'paused':
      return `The user paused the ${role}`
    case 'resumed':
      return `The ${role} resumed`
    case 'role_handoff':
      return `${oneLine(e.from)} handed the ticket to ${oneLine(e.to)}`
    case 'hand_back':
      return `${oneLine(e.from)} handed the ticket back to ${oneLine(e.to)} (agent-written details):\n${said('details', e.details)}`
    case 'role_hand_back':
      return `${oneLine(e.from)} handed the ticket back to ${oneLine(e.to)}`
    case 'criterion_checked':
      return `${role} checked criterion ${e.index}: ${data('criterion', clip(oneLine(e.text), MESSAGE_MAX), true)}`
    case 'pull_request':
      return `Mainbus pushed ${oneLine(e.branch)}${e.opened ? ' and opened' : ' for'} pull request #${e.number}: ${oneLine(e.url)}`
    default:
      // thinking, usage, session, rate_limit, status, needs_input, vcs_changed: nothing the user needs.
      return null
  }
}

/** The orchestrator's read tools: plain text, scoped to the open workspace, with agent text marked as data. */
export function createReadTools(deps: ReadToolDeps): OrchestratorReadToolHandlers {
  /** The open workspace and its board, or the text to answer with instead. */
  async function board(): Promise<{ ws: Workspace; tickets: BoardTicket[] } | string> {
    const ws = await deps.workspace()
    if (!ws) return NO_WORKSPACE
    return { ws, tickets: await deps.board(ws) }
  }

  async function ticket(number: number): Promise<{ ws: Workspace; t: BoardTicket } | string> {
    const b = await board()
    if (typeof b === 'string') return b
    const t = b.tickets.find((x) => x.number === number)
    return t ? { ws: b.ws, t } : `No ticket #${number} in ${oneLine(b.ws.name)}.`
  }

  /** The latest ticket run's roles, from its snapshot, with their strip statuses; null before the first run. */
  async function latestRun(t: BoardTicket) {
    const run = await deps.repos.runs.latest(t.id)
    if (!run) return null
    const ticketRun = await deps.repos.runs.ticketRun(run.ticketRunId)
    const strip = new Map(t.lineup.map((r) => [r.id, r]))
    const roles = ticketRun.roles.map((role) => ({ role, strip: strip.get(role.id) }))
    return { ticketRun, roles }
  }

  async function pendingLines(t: BoardTicket): Promise<string[]> {
    const pending = await deps.repos.decisions.pending(t.id)
    if (pending.length === 0) return []
    const roleOf = new Map((await deps.repos.runs.listForTicket(t.id)).map((r) => [r.id, r.role]))
    return pending
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((d) => {
        const who = oneLine(roleOf.get(d.agentRunId) ?? 'An agent')
        const options =
          d.kind === 'permission'
            ? d.allowAlways
              ? 'Allow once, Always allow, Deny'
              : 'Allow once, Deny'
            : d.options.map((o, i) => `${i + 1}. ${data('option', oneLine(o), true)}`).join(' ')
        const recommended = d.recommended !== null && d.options[d.recommended] !== undefined ? ` · recommended: ${d.recommended + 1}` : ''
        const kind = d.kind === 'permission' ? 'permission request' : 'question'
        return `- ${title(t)}: ${kind} from the ${who} (agent-written): ${data('question', clip(oneLine(d.question), MESSAGE_MAX), true)} · options: ${options}${recommended}`
      })
  }

  return {
    async listWorkspaces() {
      const ws = await deps.workspace()
      if (!ws) return NO_WORKSPACE
      return `Workspaces (1):\n- ${oneLine(ws.name)}: repo ${oneLine(ws.repoPath)}, base branch ${oneLine(ws.baseBranch)}`
    },

    async listTickets({ column }) {
      if (column !== undefined && !Object.hasOwn(COLUMNS, column)) {
        return `Unknown column "${oneLine(column)}". The columns are: ${Object.keys(COLUMNS).join(', ')}.`
      }
      const b = await board()
      if (typeof b === 'string') return b
      const tickets = b.tickets.filter((t) => column === undefined || t.state.column === column)
      const where = column === undefined ? '' : ` in ${COLUMNS[column as Column]}`
      if (tickets.length === 0) return `No tickets${where} in ${oneLine(b.ws.name)}.`
      const lines = tickets.map(
        (t) =>
          `- ${title(t)} · ${COLUMNS[t.state.column]} · phase: ${PHASES[t.state.phase]} · active role: ${activeRole(t)} · labels: ${labels(t)}` +
          heldText(t) +
          (filedByAgent(t) ? ' · filed by an agent (its title, spec and criteria are agent-written)' : '')
      )
      return `Tickets${where} in ${oneLine(b.ws.name)} (${tickets.length}):\n${lines.join('\n')}`
    },

    async getTicket({ number }) {
      const found = await ticket(number)
      if (typeof found === 'string') return found
      const { t } = found
      const byAgent = filedByAgent(t) ? ` ${AGENT_FILED_SUFFIX}` : ''
      const criteria = t.criteria.map((c) => `- [${c.checked ? 'x' : ' '}] ${c.position}: ${c.text}`).join('\n')
      const run = await latestRun(t)
      const roles = run
        ? run.roles
            .map(({ role, strip }) => `- ${oneLine(role.name)}: ${strip ? ROLE_STATUSES[strip.status] : 'not started'}${strip?.active ? ' (active)' : ''}`)
            .join('\n')
        : // Before the first run the strip is the workspace lineup: the roles propose_start can name.
          `Not started. The lineup's roles, in order: ${t.lineup.map((r) => oneLine(r.name)).join(', ') || 'none'}.`
      const pr = t.pr ? oneLine(t.pr.url) : 'none'
      const sections = [
        `## Ticket ${title(t)}${filedByAgent(t) ? ` ${AGENT_FILED_SUFFIX}` : ''}\nColumn: ${COLUMNS[t.state.column]} · phase: ${PHASES[t.state.phase]}${heldText(t)}`,
        ...intentSections(t),
        t.spec ? `## Spec${byAgent}\n${data('spec', t.spec)}` : `## Spec\nNone.`,
        criteria ? `## Acceptance criteria${byAgent}\n${data('criteria', criteria)}` : `## Acceptance criteria\nNone.`,
        `## Labels\n${labels(t)}`,
        `## Pull request\n${pr}${t.prError ? `\nThe last push or pull request failed: ${data('pr-error', clip(t.prError, MESSAGE_MAX))}` : ''}`,
        `## Latest run\n${roles}`
      ]
      return sections.join('\n\n')
    },

    async getRunStatus({ number }) {
      const found = await ticket(number)
      if (typeof found === 'string') return found
      const { t } = found
      const run = await latestRun(t)
      if (!run) return `${title(t)} has not started yet.`
      const roles = run.roles.map(({ role, strip }, i) => {
        const status = strip ? ROLE_STATUSES[strip.status] : 'not started'
        return `${i + 1}. ${oneLine(role.name)}: ${status}${strip?.active ? ' (active)' : ''} · model ${role.model ?? 'default'}, effort ${role.effort ?? 'default'}`
      })
      const pending = await pendingLines(t)
      return [
        `${title(t)}: ${COLUMNS[t.state.column]} · phase: ${PHASES[t.state.phase]}`,
        `Latest run, started ${localStamp(run.ticketRun.startedAt)} (${run.ticketRun.status}). Roles in order:\n${roles.join('\n')}`,
        `Active role: ${activeRole(t)}`,
        pending.length ? `Pending decisions:\n${pending.join('\n')}` : 'Pending decisions: none'
      ].join('\n\n')
    },

    async getRecentEvents({ number, limit }) {
      const found = await ticket(number)
      if (typeof found === 'string') return found
      const { t } = found
      const n = Math.min(EVENTS_MAX, Math.max(1, Math.floor(limit ?? EVENTS_DEFAULT)))
      const runs = await deps.repos.runs.listForTicket(t.id)
      const decisions = new Map((await deps.repos.decisions.forTicket(t.id)).map((d) => [d.id, d]))
      const lines: string[] = []
      for (const run of runs) {
        const events: StoredEvent[] = await deps.repos.runs.events(run.id)
        for (const e of events) {
          const line = describe(e.event, oneLine(run.role), decisions)
          if (line !== null) lines.push(`[${localStamp(e.at)}] ${line}`)
        }
      }
      if (lines.length === 0) return `${title(t)} has no events yet.`
      const last = lines.slice(-n)
      return `The last ${last.length} of ${lines.length} events of ${title(t)}, oldest first:\n${last.join('\n')}`
    },

    async listPendingDecisions() {
      const b = await board()
      if (typeof b === 'string') return b
      const lines = (await Promise.all(b.tickets.map(pendingLines))).flat()
      if (lines.length === 0) return `No decisions are waiting for the user in ${oneLine(b.ws.name)}.`
      return `Decisions waiting for the user (${lines.length}):\n${lines.join('\n')}`
    }
  }
}
