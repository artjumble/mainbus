import fs from 'node:fs/promises'
import type { BoardTicket } from '../../shared/api'
import { openBlockers } from '../../shared/dependencies'
import type { BaseTestsSummary, Column, Decision, LineupPreset, LineupRole, Phase, RoleStatus, StuckEpisode, UsageState, Workspace } from '../../shared/domain'
import type { StoredEvent, ThreadEvent } from '../../shared/events'
import { ordinal } from '../../shared/queue'
import { applyRunSettings, runSettingsSummary } from '../../shared/runSettings'
import { usageBannerText } from '../../shared/usage'
import { clockTime } from '../../shared/waiting'
import { knownFailuresText } from '../baseline/text'
import { AGENT_FILED_SUFFIX, data, intentSections, oneLine } from '../roles/prompt'
import type { OrchestratorReadToolHandlers } from '../runtime/types'
import { NO_WORKSPACE, resolveWorkspaceRef } from './workspaceRef'
import { NOT_RECORDED, ticketUsage, usageLine } from '../../shared/usageTotals'
import type { Repos } from '../store'
import { ticketTimeFor, workspaceTimeFor, TIME_REPORT_DEFAULT, TIME_REPORT_MAX } from '../time/report'
import { categoryLine, commandLine, formatMinutes, TIME_LABELS, TIME_CATEGORIES, type CategoryMs, type CommandTime } from '../../shared/timeBreakdown'
import { STUCK_RULE_TEXT } from '../stuck/config'
import { firedAgainAfterRedirect } from '../stuck/ladder'
import { mergedText } from '../../shared/merge'

export interface ReadToolDeps {
  repos: Pick<Repos, 'runs' | 'decisions' | 'stuck' | 'lineups' | 'presets' | 'tickets'>
  /** The focused workspace, or null. */
  focused(): Promise<Workspace | null>
  /** Every open workspace, oldest first. */
  list(): Promise<Workspace[]>
  /** The workspace's tickets as the board shows them: state and lineup strip. */
  board(ws: Workspace): Promise<BoardTicket[]>
  /** Where the app stands on the usage limit; without it nothing is said about it. */
  usage?: () => Promise<UsageState>
  /** The images the user attached to the ticket, with where their files are; without it none are listed. */
  attachments?: (ticketId: string) => Promise<{ filename: string; path: string }[]>
  /** What is known about the workspace's base-branch tests; null when it has no test commands or no finished run. Without it none is shown. */
  baseTests?: (ws: Workspace) => Promise<BaseTestsSummary | null>
}

/** Agent messages, handoffs and the like are cut to this many characters. */
export const MESSAGE_MAX = 2000
/** A tool call is shown as its name and a summary of its input of at most this many characters. */
export const TOOL_SUMMARY_MAX = 120
export const EVENTS_DEFAULT = 20
export const EVENTS_MAX = 50

export { NO_WORKSPACE }

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
  queued: 'queued',
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

/** " · blocked by #39, #40 (not Done; don't propose starting it)" while a blocker isn't Done, else nothing. */
function blockedText(t: BoardTicket): string {
  const open = openBlockers(t.blockedBy)
  if (open.length === 0) return ''
  return ` · blocked by ${open.map((b) => `#${b.number}`).join(', ')} (not Done; don't propose starting it)`
}

/** " · behind main" or " · conflicts with main (propose_update_from_main)" for an open ticket whose branch lags the base, else nothing. */
function freshnessSuffix(t: BoardTicket): string {
  const f = t.freshness
  if (!f || f.behind === 0) return ''
  if (f.conflicts.length > 0) return ` · conflicts with ${f.baseBranch} (propose_update_from_main)`
  return ` · behind ${f.baseBranch}`
}

/** How far the branch is behind the newest base, and the files a merge would conflict in (file names come from the repo, so data). */
function freshnessSection(t: BoardTicket): string {
  const f = t.freshness
  if (!f) return t.branch === null ? 'No branch yet.' : 'Not checked.'
  const fetched = f.fetchError
    ? ` The newest ${f.baseBranch} could not be fetched (${data('fetch-error', clip(f.fetchError, MESSAGE_MAX), true)}), so this compares with ${f.base}.`
    : ''
  if (f.behind === 0) return `Up to date with ${f.base}.${fetched}`
  const files = f.conflicts.map((c) => `- ${data('conflict-file', oneLine(c), true)}`).join('\n')
  const conflicts =
    f.conflicts.length > 0
      ? ` Merging it would conflict in:\n${files}\nUpdate from main (propose_update_from_main) starts the Implementer on it, if no role is working.`
      : ' It would merge cleanly.'
  return `${f.behind} commit${f.behind === 1 ? '' : 's'} behind ${f.base}.${conflicts}${fetched}`
}

/** The ticket's blockers, each with whether it is Done. */
function blockersSection(t: BoardTicket): string {
  if (t.blockedBy.length === 0) return 'None.'
  return t.blockedBy.map((b) => `- #${b.number} ${data('blocker', oneLine(b.title), true)}: ${b.done ? 'Done' : 'not Done yet'}`).join('\n')
}

/** " · held until 2026-11-04" for a held ticket, else nothing. */
function heldText(t: BoardTicket): string {
  if (!t.hold) return ''
  const until = t.hold.until === null ? 'until the user releases it' : `until ${t.hold.until.slice(0, 10)}`
  return ` · held by the user ${until} (don't propose starting it)`
}

/** The run settings the user saved for the ticket against its lineup now, with what was dropped, or that there are none. */
function runSettingsText(t: BoardTicket, lineup: LineupRole[]): string {
  if (t.runSettings === null) return "None saved: the lineup's defaults."
  const { options } = applyRunSettings(t.runSettings, lineup)
  const run = lineup.filter((r) => options.roleIds?.includes(r.id))
  const lines = [
    `Roles that run, in order: ${run.map((r) => oneLine(r.name)).join(', ')}. Keep exactly these roles when proposing a start.`,
    ...run
      .filter((r) => options.roles?.[r.id] !== undefined)
      .map((r) => {
        const { model, effort } = options.roles![r.id]!
        return `- ${oneLine(r.name)}: model ${model ?? '(yours to choose)'}, effort ${effort ?? '(yours to choose)'}`
      }),
    options.extraInstructions !== undefined
      ? `Extra instructions (the user's):\n${data('run-settings-extra', options.extraInstructions)}`
      : 'Extra instructions: none saved.',
    ...t.runSettingsNotices.map((n) => `Notice: ${n}`)
  ]
  return lines.join('\n')
}

/** The workspace's presets, one line each: the name and what it comes to for the lineup. */
function presetLines(presets: LineupPreset[], lineup: LineupRole[]): string {
  if (presets.length === 0) return 'None.'
  return presets
    .map((p) => {
      const { options, notices } = applyRunSettings(p.settings, lineup)
      return `- ${oneLine(p.name)}: ${runSettingsSummary(options, lineup)}${notices.map((n) => ` (${oneLine(n)})`).join('')}`
    })
    .join('\n')
}

function activeRole(t: BoardTicket): string {
  return t.lineup.find((r) => r.active)?.name ?? 'none'
}

/** " · queued (2nd) for a free agent slot" while the ticket's agent waits for one, else nothing. */
function queuedText(t: BoardTicket): string {
  if (t.state.agentStatus !== 'queued') return ''
  const place = t.state.queuePosition === undefined ? '' : ` (${ordinal(t.state.queuePosition)} in line)`
  return ` · queued${place}: every agent slot is in use, so its agent starts when one frees up (first in, first out)`
}

/** " · paused by the usage limit (resumes at 14:00)..." while the usage limit holds the ticket's agent, else nothing. */
function limitText(t: BoardTicket, usage: UsageState): string {
  if (!t.state.pausedByLimit) return ''
  const when = usage.kind === 'limited' ? (usage.resetsAt ?? usage.retryAt) : null
  const at = when === null ? '' : ` (${usage.kind === 'limited' && usage.resetsAt === null ? 'trying again' : 'resumes'} at ${clockTime(when)})`
  return ` · paused by the usage limit${at}; Mainbus resumes it by itself, or the user can resume it early`
}

/** The ticket's folder; its path stays after Done, when the folder is removed. */
async function folderText(worktreePath: string | null): Promise<string> {
  if (worktreePath === null) return 'None yet: Mainbus makes it when the ticket first starts.'
  const there = await fs.stat(worktreePath).then(() => true, () => false)
  return `${oneLine(worktreePath)}${there ? '' : ' (no longer there)'}`
}

/** Where Mainbus saved an Investigate ticket's report in the repo, with the commit, or why the latest save failed. */
function reportFileText(t: BoardTicket): string {
  const file = t.reportFile === null ? 'the report' : `${oneLine(t.reportFile)}, relative to the repository,`
  const where = `${file} on the branch ${oneLine(t.branch ?? 'none')}`
  if (t.reportCommit !== null) return `Saved as ${where}, in commit ${t.reportCommit}.`
  const why = t.reportFileError ? `: ${data('report-file-error', clip(t.reportFileError, MESSAGE_MAX))}` : ''
  return `Not saved: the latest save of ${where} failed${why}\nThe report itself is kept on the ticket; the user can retry with "Save report to repo".`
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

/** The open stuck episode of the run, with the detector's evidence (text from the agent's log, so data). */
function stuckText(s: StuckEpisode): string {
  const look = s.needsCloserLook ? ` It has been flagged ${s.hitCount} times and needs a closer look.` : ''
  const evidence = s.evidence.map((line) => `- ${data('stuck-evidence', oneLine(line), true)}`).join('\n')
  const redirected = !s.redirectedAt
    ? ''
    : firedAgainAfterRedirect(s)
      ? ` It was redirected once at ${localStamp(s.redirectedAt)} and has fired again: propose a replacement, not another redirect.`
      : ` It was already redirected once at ${localStamp(s.redirectedAt)} and has not fired again since: propose neither a redirect nor a replacement yet.`
  return `Looks stuck (opened ${localStamp(s.openedAt)}; ${STUCK_RULE_TEXT[s.rule]}).${look}${redirected} Evidence:\n${evidence}`
}

function answerText(d: Decision): string {
  if (d.status !== 'answered' || d.answer === null) return d.status === 'pending' ? 'not answered yet' : d.status === 'deferred' ? 'deferred' : d.status
  const a = d.answer
  if (a.kind === 'message') return `answered: ${data('answer', oneLine(`in a message: ${a.text}`), true)}`
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
    case 'queued':
      return `The ${role} waited for a free agent slot`
    case 'redirected':
      return `The user redirected the ${oneLine(e.role)}, as you suggested; the agent was interrupted and sent this message: ${data('redirect', clip(oneLine(e.text), MESSAGE_MAX), true)}`
    case 'replaced':
      return `The user replaced the ${oneLine(e.role)}: its agent ended and a fresh one took over from a summary of its log`
    case 'waiting':
      return `${role} declared a wait (agent-written): ${data('wait-reason', clip(oneLine(e.reason), MESSAGE_MAX), true)}, until ${clockTime(e.until)}`
    case 'role_handoff':
      return `${oneLine(e.from)} handed the ticket to ${oneLine(e.to)}`
    case 'hand_back':
      return `${oneLine(e.from)} handed the ticket back to ${oneLine(e.to)} (agent-written details):\n${said('details', e.details)}`
    case 'role_hand_back':
      return `${oneLine(e.from)} handed the ticket back to ${oneLine(e.to)}`
    case 'criterion_checked':
      return `${role} checked criterion ${e.index}: ${data('criterion', clip(oneLine(e.text), MESSAGE_MAX), true)}`
    case 'report_file':
      return `Mainbus saved the report as ${oneLine(e.path)} and committed it on ${oneLine(e.branch)} (${e.commit.slice(0, 7)})`
    case 'pull_request':
      return `Mainbus pushed ${oneLine(e.branch)}${e.opened ? ' and opened' : ' for'} pull request #${e.number}: ${oneLine(e.url)}`
    case 'merged':
      return `${mergedText(e)}${e.commit ? `, ${e.base} is now at ${e.commit.slice(0, 7)}` : ''}`
    default:
      // thinking, usage, session, rate_limit, status, needs_input, vcs_changed: nothing the user needs.
      return null
  }
}

/** The orchestrator's read tools: plain text, scoped to the open workspace, with agent text marked as data. */
export function createReadTools(deps: ReadToolDeps): OrchestratorReadToolHandlers {
  const usageNow = async (): Promise<UsageState> => (await deps.usage?.()) ?? { kind: 'ok' }

  /** The named workspace (the focused one by default) and its board, or the text to answer with instead. */
  async function board(ref?: string): Promise<{ ws: Workspace; tickets: BoardTicket[] } | string> {
    const found = resolveWorkspaceRef(await deps.list(), await deps.focused(), ref)
    if (!found.ok) return found.text
    return { ws: found.ws, tickets: await deps.board(found.ws) }
  }

  async function ticket(number: number, ref?: string): Promise<{ ws: Workspace; t: BoardTicket } | string> {
    const b = await board(ref)
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

  /** What the ticket's runs used, in plain lines; "Not recorded" for runs from before usage was kept. */
  async function usageSection(t: BoardTicket): Promise<string> {
    const runs = await deps.repos.runs.listForTicket(t.id)
    if (runs.length === 0) return 'Not started.'
    const events = (await Promise.all(runs.map((run) => deps.repos.runs.events(run.id)))).flat()
    const usage = ticketUsage(events, runs.map((run) => ({ id: run.id, ticketRunId: run.ticketRunId, role: run.role })))
    const lines = [
      usage.total ? `Total: ${usageLine(usage.total)}` : `Total: ${NOT_RECORDED}`,
      ...usage.runs.flatMap((r) => [
        `Run ${r.n}: ${r.usage ? usageLine(r.usage) : NOT_RECORDED}`,
        ...r.roles.map((x) => `- ${oneLine(x.role)}: ${x.usage ? usageLine(x.usage) : NOT_RECORDED}`),
        ...(r.mainbus ? [`- Mainbus's own calls: ${usageLine(r.mainbus)}`] : [])
      ])
    ]
    return lines.join('\n')
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
        return `- ${title(t)}: ${kind} (decision ${d.id}) from the ${who} (agent-written): ${data('question', clip(oneLine(d.question), MESSAGE_MAX), true)} · options: ${options}${recommended}`
      })
  }

  async function baseTestsSuffix(ws: Workspace): Promise<string> {
    if (!deps.baseTests) return ''
    if (ws.testCommands.length === 0) return ' · base tests: off'
    const summary = await deps.baseTests(ws).catch(() => null)
    if (summary === null) return ' · base tests: not run yet'
    const at = summary.baseSha.slice(0, 7)
    if (summary.error !== null) return ` · base tests: couldn't run at ${at}`
    if (summary.knownFailures.length === 0) return ` · base tests: all passed at ${at}`
    const intermittent = summary.knownFailures.filter((f) => f.intermittent).length
    return ` · base tests: ${summary.knownFailures.length} known failures (${intermittent} intermittent) at ${at}`
  }

  return {
    async listWorkspaces() {
      const all = await deps.list()
      if (all.length === 0) return NO_WORKSPACE
      const focused = await deps.focused()
      const lines = await Promise.all(
        all.map(async (ws) => {
          const needsYou = (await deps.board(ws)).filter((t) => t.state.column === 'needs_you').length
          const mark = ws.id === focused?.id ? ' · focused (the one the user is looking at)' : ''
          const presets = (await deps.repos.presets.list(ws.id)).map((p) => oneLine(p.name))
          const tests = await baseTestsSuffix(ws)
          return `- ${oneLine(ws.name)} (id ${ws.id}): repo ${oneLine(ws.repoPath)}, base branch ${oneLine(ws.baseBranch)} · Needs you: ${needsYou}${mark} · presets: ${presets.length === 0 ? 'none' : presets.join(', ')}${tests}`
        })
      )
      return `Workspaces (${all.length}):\n${lines.join('\n')}`
    },

    async listTickets({ workspace, column }) {
      if (column !== undefined && !Object.hasOwn(COLUMNS, column)) {
        return `Unknown column "${oneLine(column)}". The columns are: ${Object.keys(COLUMNS).join(', ')}.`
      }
      const b = await board(workspace)
      if (typeof b === 'string') return b
      const usage = await usageNow()
      const tickets = b.tickets.filter((t) => column === undefined || t.state.column === column)
      const where = column === undefined ? '' : ` in ${COLUMNS[column as Column]}`
      if (tickets.length === 0) return `No tickets${where} in ${oneLine(b.ws.name)}.`
      const lines = tickets.map(
        (t) =>
          `- ${title(t)} · ${COLUMNS[t.state.column]} · phase: ${PHASES[t.state.phase]} · active role: ${activeRole(t)} · labels: ${labels(t)}` +
          queuedText(t) +
          limitText(t, usage) +
          heldText(t) +
          blockedText(t) +
          freshnessSuffix(t) +
          (filedByAgent(t) ? ' · filed by an agent (its title, spec and criteria are agent-written)' : '')
      )
      return `Tickets${where} in ${oneLine(b.ws.name)} (${tickets.length}):\n${lines.join('\n')}`
    },

    async getTicket({ workspace, number }) {
      const found = await ticket(number, workspace)
      if (typeof found === 'string') return found
      const { t } = found
      const byAgent = filedByAgent(t) ? ` ${AGENT_FILED_SUFFIX}` : ''
      const criteria = t.criteria.map((c) => `- [${c.checked ? 'x' : ' '}] ${c.position}: ${c.text}`).join('\n')
      const promoted = (await deps.board(found.ws))
        .filter((x) => x.promotedFrom === t.id || x.id === t.promotedFrom)
        .map((x) => (x.id === t.promotedFrom ? `Promoted from ${title(x)}` : `Promoted to ${title(x)}`))
      const run = await latestRun(t)
      const roles = run
        ? run.roles
            .map(({ role, strip }) => `- ${oneLine(role.name)}: ${strip ? ROLE_STATUSES[strip.status] : 'not started'}${strip?.active ? ' (active)' : ''}`)
            .join('\n')
        : // Before the first run the strip is the workspace lineup: the roles propose_start can name.
          `Not started. The lineup's roles, in order: ${t.lineup.map((r) => oneLine(r.name)).join(', ') || 'none'}.`
      const pr = t.pr ? oneLine(t.pr.url) : 'none'
      const folder = await folderText(t.worktreePath)
      const images = (await deps.attachments?.(t.id)) ?? []
      const attached = images.length
        ? `The user attached these images (the user's own material); open them with Read when they matter:\n${images
            .map((a) => `- ${data('attachment', oneLine(a.filename), true)}: ${oneLine(a.path)}`)
            .join('\n')}`
        : 'None.'
      const baseTests = (await deps.baseTests?.(found.ws).catch(() => null)) ?? null
      const sections = [
        `## Ticket ${title(t)}${filedByAgent(t) ? ` ${AGENT_FILED_SUFFIX}` : ''}\nKind: ${t.kind === 'investigate' ? 'Investigate' : 'Change'} · column: ${COLUMNS[t.state.column]} · phase: ${PHASES[t.state.phase]}${heldText(t)}${blockedText(t)}`,
        ...(promoted.length ? [promoted.join('\n')] : []),
        ...intentSections(t),
        t.spec ? `## Spec${byAgent}\n${data('spec', t.spec)}` : `## Spec\nNone.`,
        criteria ? `## Acceptance criteria${byAgent}\n${data('criteria', criteria)}` : `## Acceptance criteria\nNone.`,
        `## Labels\n${labels(t)}`,
        `## Blocked by\n${blockersSection(t)}`,
        ...(baseTests ? [`## Known test results on ${oneLine(found.ws.baseBranch)}\n${knownFailuresText(baseTests)}`] : []),
        `## Branch and ${t.freshness?.baseBranch ?? 'main'}\n${freshnessSection(t)}`,
        `## Attachments\n${attached}`,
        `## Folder\n${folder}`,
        `## Pull request\n${pr}${t.prError ? `\nThe last push or pull request failed: ${data('pr-error', clip(t.prError, MESSAGE_MAX))}` : ''}`,
        `## Latest run\n${roles}`,
        `## Usage\n${await usageSection(t)}`,
        `## Run settings (the user's)\n${runSettingsText(t, await deps.repos.lineups.get(found.ws.id, t.kind))}`,
        ...(t.kind === 'change'
          ? [`## Presets (the workspace's; set one with a preset argument)\n${presetLines(await deps.repos.presets.list(found.ws.id), await deps.repos.lineups.get(found.ws.id, t.kind))}`]
          : []),
        ...(t.kind === 'investigate' ? [`## Report\n${t.report ? data('report', t.report) : 'None yet.'}`] : []),
        ...(t.kind === 'investigate' && (t.reportFile !== null || t.reportFileError !== null) ? [`## Report file\n${reportFileText(t)}`] : []),
        ...(t.kind === 'change' && t.report ? [`## Investigation report\n${data('report', t.report)}`] : [])
      ]
      return sections.join('\n\n')
    },

    async getRunStatus({ workspace, number }) {
      const found = await ticket(number, workspace)
      if (typeof found === 'string') return found
      const { t } = found
      const run = await latestRun(t)
      if (!run) return `${title(t)} has not started yet.`
      const roles = run.roles.map(({ role, strip }, i) => {
        const status = strip ? ROLE_STATUSES[strip.status] : 'not started'
        return `${i + 1}. ${oneLine(role.name)}: ${status}${strip?.active ? ' (active)' : ''} · model ${role.model ?? 'default'}, effort ${role.effort ?? 'default'}`
      })
      const pending = await pendingLines(t)
      const latest = await deps.repos.runs.latest(t.id)
      const stuck = latest ? await deps.repos.stuck.open(latest.id) : null
      const usage = await usageNow()
      return [
        `${title(t)}: ${COLUMNS[t.state.column]} · phase: ${PHASES[t.state.phase]}`,
        `Latest run, started ${localStamp(run.ticketRun.startedAt)} (${run.ticketRun.status}). Roles in order:\n${roles.join('\n')}`,
        `Active role: ${activeRole(t)}${queuedText(t)}${limitText(t, usage)}`,
        ...(usage.kind === 'ok' ? [] : [usageBannerText(usage)]),
        pending.length ? `Pending decisions:\n${pending.join('\n')}` : 'Pending decisions: none',
        ...(t.freshness && t.freshness.behind > 0 ? [`Branch: ${freshnessSection(t)}`] : []),
        ...(stuck ? [stuckText(stuck)] : [])
      ].join('\n\n')
    },

    async getRecentEvents({ workspace, number, limit }) {
      const found = await ticket(number, workspace)
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

    async getTimeReport({ workspace, ticket: number, last }) {
      const commandLines = (commands: CommandTime[]): string[] =>
        commands.length === 0 ? ['None.'] : commands.map((c) => `- ${data('command', oneLine(commandLine(c)), true)}`)
      const split = (by: CategoryMs): string => categoryLine(by) || 'no time recorded'
      if (number !== undefined) {
        const found = await ticket(number, workspace)
        if (typeof found === 'string') return found
        const time = await ticketTimeFor(deps.repos, found.t.id)
        if (time.runCount === 0) return `${title(found.t)} has not run.`
        const lines = [
          `Time for ${title(found.t)}: ${formatMinutes(time.totalMs)} in ${time.runCount} ${time.runCount === 1 ? 'run' : 'runs'} and ${time.roleCount} ${time.roleCount === 1 ? 'role' : 'roles'}; ${
            time.toReviewMs === null ? 'it has not reached Review' : `${formatMinutes(time.toReviewMs)} from the first start to Review`
          }`,
          `Where it went: ${split(time.byCategory)}`,
          ...time.runs.flatMap((g) => [
            `Run ${g.n}: ${formatMinutes(g.totalMs)}`,
            ...g.roles.map((r) => `- ${oneLine(r.role)}: ${formatMinutes(r.totalMs)} (${split(r.byCategory)})`)
          ]),
          'Longest commands:',
          ...commandLines(time.commands),
          ...time.turnChecks.map(
            (c) => `Note: the ${oneLine(c.role)}'s recorded turn time (${formatMinutes(c.check.recordedMs)}) differs a lot from the log's (${formatMinutes(c.check.computedMs)}).`
          )
        ]
        return lines.join('\n')
      }
      const b = await board(workspace)
      if (typeof b === 'string') return b
      const count = Math.min(TIME_REPORT_MAX, Math.max(1, Math.floor(last ?? TIME_REPORT_DEFAULT)))
      const report = await workspaceTimeFor(deps.repos, b.ws.id, { last: count })
      if (report.ticketCount === 0) return `No ticket in ${oneLine(b.ws.name)} has reached Review yet.`
      const lines = [
        `Where time went over the last ${report.ticketCount} ${report.ticketCount === 1 ? 'ticket' : 'tickets'} to reach Review in ${oneLine(b.ws.name)}: ${formatMinutes(report.totalMs)} in total, ${formatMinutes(report.averageMs)} on average; median time to Review ${report.medianToReviewMs === null ? 'unknown' : formatMinutes(report.medianToReviewMs)}`,
        'By category (total, average per ticket):',
        ...TIME_CATEGORIES.filter((c) => report.byCategory[c.id] > 0).map((c) => `- ${TIME_LABELS[c.id]}: ${formatMinutes(report.byCategory[c.id])}, ${formatMinutes(report.averages[c.id])}`),
        'By role:',
        ...report.roles.map((r) => `- ${oneLine(r.role)} (in ${r.tickets} ${r.tickets === 1 ? 'ticket' : 'tickets'}): ${formatMinutes(r.totalMs)} (${split(r.byCategory)})`),
        'Longest commands in total:',
        ...commandLines(report.commands)
      ]
      return lines.join('\n')
    },

    async listPendingDecisions({ workspace } = {}) {
      const b = await board(workspace)
      if (typeof b === 'string') return b
      const lines = (await Promise.all(b.tickets.map(pendingLines))).flat()
      if (lines.length === 0) return `No decisions are waiting for the user in ${oneLine(b.ws.name)}.`
      return `Decisions waiting for the user (${lines.length}):\n${lines.join('\n')}`
    }
  }
}
