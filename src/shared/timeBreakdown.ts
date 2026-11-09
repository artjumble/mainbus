// Shared by the engine and the renderer: pure functions only, no Node imports.
// Where an agent run's time went, rebuilt from the events and decisions Mainbus already stores.
import { classifyTool, isShellTool, type ToolCategory } from './commandCategory'
import { inputText, normalizeCommand } from './commands'
import type { Decision } from './domain'
import type { StoredEvent, ThreadEvent } from './events'
import { isUsagePauseNotice } from './usage'

export type TimeCategory =
  | 'permission'
  | 'question'
  | 'paused'
  | 'usage_limited'
  | 'queued'
  | 'setup'
  | 'tests'
  | 'build'
  | 'install'
  | 'git'
  | 'reading'
  | 'editing'
  | 'web'
  | 'mainbus'
  | 'other_tool'
  | 'model'
  | 'between'

/** In display order. */
export const TIME_CATEGORIES: { id: TimeCategory; label: string }[] = [
  { id: 'permission', label: 'Waiting on you: permissions' },
  { id: 'question', label: 'Waiting on you: questions' },
  { id: 'paused', label: 'Paused' },
  { id: 'usage_limited', label: 'Usage limit' },
  { id: 'queued', label: 'Queued' },
  { id: 'setup', label: 'Setup step' },
  { id: 'tests', label: 'Tests' },
  { id: 'build', label: 'Build and typecheck' },
  { id: 'install', label: 'Install' },
  { id: 'git', label: 'Git' },
  { id: 'reading', label: 'Reading and searching' },
  { id: 'editing', label: 'Editing' },
  { id: 'web', label: 'Web' },
  { id: 'mainbus', label: 'Mainbus tools' },
  { id: 'other_tool', label: 'Other commands' },
  { id: 'model', label: 'Model' },
  { id: 'between', label: 'Between turns or roles' }
]

export const TIME_LABELS: Record<TimeCategory, string> = Object.fromEntries(TIME_CATEGORIES.map((c) => [c.id, c.label])) as Record<TimeCategory, string>

export type CategoryMs = Record<TimeCategory, number>

export function emptyCategoryMs(): CategoryMs {
  return Object.fromEntries(TIME_CATEGORIES.map((c) => [c.id, 0])) as CategoryMs
}

/** Which category wins when periods overlap: the earlier one here. Time in a turn that none covers is the model's; outside a turn it is "between". */
const PRIORITY: TimeCategory[] = [
  'permission', 'question', 'paused', 'usage_limited', 'queued', 'setup',
  'tests', 'build', 'install', 'git', 'other_tool', 'editing', 'reading', 'web', 'mainbus'
]
const TURN = PRIORITY.length

const COMMAND_CLIP = 120

export interface CommandTime {
  command: string
  count: number
  /** Running time: call to result, less any time a decision (permission or question) was open on the run. */
  ms: number
  /** Time spent waiting on a decision while the call was open. */
  waitedMs: number
}

export interface TurnCheck {
  /** The summed `durationMs` of the run's usage events. */
  recordedMs: number
  /** The summed length of the turns as the log's events show them, from a turn's first event to its end. */
  computedMs: number
  disagrees: boolean
}

export interface TimeRunInput {
  id: string
  ticketRunId: string
  role: string
  startedAt: string
  endedAt: string | null
}

export interface RunTime {
  runId: string
  ticketRunId: string
  role: string
  startedAt: string
  endedAt: string | null
  totalMs: number
  byCategory: CategoryMs
  commands: CommandTime[]
  turnCheck: TurnCheck | null
}

interface Interval {
  s: number
  e: number
}

const TURN_TRIGGERS = new Set<ThreadEvent['kind']>([
  'session', 'user_message', 'nudge', 'redirected', 'resumed', 'message', 'thinking', 'tool_call', 'tool_result', 'needs_input', 'error'
])
const LIMIT_ENDS = new Set<ThreadEvent['kind']>(['queued', 'session', 'stopped', 'message', 'thinking', 'tool_call'])
const QUEUE_ENDS = new Set<ThreadEvent['kind']>(['session', 'stopped', 'message', 'thinking', 'tool_call', 'turn_end'])
const TURN_CLOSES = new Set<ThreadEvent['kind']>(['process_exit', 'stopped'])

function ms(at: string): number {
  const t = Date.parse(at)
  return Number.isNaN(t) ? 0 : t
}

/** Splits [start, end] by the intervals, in the priority order; what is left in a turn is the model's. */
export function runBreakdown(input: { run: TimeRunInput; events: StoredEvent[]; decisions: Decision[]; now: number }): RunTime {
  const { run, decisions, now } = input
  const start = ms(run.startedAt)
  const end = Math.max(start, run.endedAt !== null ? ms(run.endedAt) : now)
  const events = [...input.events].sort((a, b) => a.seq - b.seq)
  const clip = (s: number, e: number): Interval | null => {
    const iv = { s: Math.max(s, start), e: Math.min(e, end) }
    return iv.e > iv.s ? iv : null
  }

  const intervals: Interval[][] = [...PRIORITY, "turn"].map(() => [])
  const add = (cat: TimeCategory, s: number, e: number): void => {
    const iv = clip(s, e)
    if (iv) intervals[PRIORITY.indexOf(cat)]!.push(iv)
  }
  const turns: Interval[] = []

  // Waiting on the user: a decision is open from its creation to its answer, deferred ones too.
  const answersToQuestions: number[] = []
  const decisionOpen: Interval[] = []
  for (const d of decisions) {
    if (d.agentRunId !== run.id) continue
    const open = d.status === 'pending' || d.status === 'deferred'
    const s = ms(d.createdAt)
    const e = d.answeredAt !== null ? ms(d.answeredAt) : open ? end : s
    add(d.kind === 'permission' ? 'permission' : 'question', s, e)
    if (e > s) decisionOpen.push({ s, e })
    if (d.kind === 'question' && d.answeredAt !== null) answersToQuestions.push(e)
  }
  answersToQuestions.sort((a, b) => a - b)

  // Paused, usage-limited and queued; each lasts until a later event ends it.
  const endOf = (from: number, ends: Set<ThreadEvent['kind']>): number => {
    for (let j = from + 1; j < events.length; j++) if (ends.has(events[j]!.event.kind)) return ms(events[j]!.at)
    return end
  }
  const openTools = new Map<string, { at: number; cat: ToolCategory; command: string | null }>()
  const commands = new Map<string, CommandTime>()
  const countCommand = (command: string, s: number, e: number): void => {
    const key = normalizeCommand(command).slice(0, COMMAND_CLIP)
    const cur = commands.get(key) ?? { command: key, count: 0, ms: 0, waitedMs: 0 }
    const from = Math.max(s, start)
    const to = Math.min(e, end)
    // Decisions may overlap each other: merge them so the wait is counted once.
    let waited = 0
    let upTo = from
    for (const d of [...decisionOpen].sort((a, b) => a.s - b.s)) {
      const ds = Math.max(d.s, upTo, from)
      const de = Math.min(d.e, to)
      if (de > ds) {
        waited += de - ds
        upTo = de
      }
    }
    cur.count++
    cur.ms += Math.max(0, to - from - waited)
    cur.waitedMs += waited
    commands.set(key, cur)
  }
  const closeTool = (id: string, e: number): void => {
    const t = openTools.get(id)
    if (!t) return
    openTools.delete(id)
    add(t.cat, t.at, e)
    if (t.command !== null) countCommand(t.command, t.at, e)
  }

  // Turns: a turn runs from its first event to its turn_end (or to the process ending); with usage events its start is exact.
  let turnStart = null as number | null
  let lastEnd = start
  let recordedMs = 0
  let hasUsage = false
  let loggedMs = 0
  const closeTurn = (e: number, usageStart?: number): void => {
    const s = usageStart !== undefined ? Math.max(lastEnd, usageStart) : (turnStart ?? usageStart)
    // What the log alone says: from the turn's first event, to compare with the duration the SDK recorded.
    const logged = turnStart ?? s
    if (logged !== null && logged !== undefined && e > logged) loggedMs += e - logged
    if (s !== null && s !== undefined && e > s) turns.push({ s, e })
    turnStart = null
    lastEnd = Math.max(lastEnd, e)
  }

  for (let i = 0; i < events.length; i++) {
    const { event: ev } = events[i]!
    const at = ms(events[i]!.at)
    if (turnStart === null && TURN_TRIGGERS.has(ev.kind)) {
      const answered = answersToQuestions.find((a) => a > lastEnd && a <= at)
      turnStart = Math.max(lastEnd, answered ?? at)
    }
    switch (ev.kind) {
      case 'paused': {
        let e = end
        for (let j = i + 1; j < events.length; j++) {
          const k = events[j]!.event.kind
          if (k === 'resumed' || k === 'stopped') {
            e = ms(events[j]!.at)
            break
          }
        }
        add('paused', at, e)
        break
      }
      case 'notice':
        if (isUsagePauseNotice(ev.text)) add('usage_limited', at, endOf(i, LIMIT_ENDS))
        break
      case 'queued':
        add('queued', at, endOf(i, QUEUE_ENDS))
        break
      case 'setup':
        add('setup', at - ev.durationMs, at)
        break
      case 'tool_call': {
        const command = isShellTool(ev.name) ? inputText(ev.input) : null
        openTools.set(ev.id, { at, cat: classifyTool(ev.name, command), command })
        break
      }
      case 'tool_result':
        closeTool(ev.id, at)
        break
      case 'usage':
        if (ev.call === undefined) {
          hasUsage = true
          recordedMs += ev.durationMs
          const next = events[i + 1]?.event
          if (next?.kind === 'turn_end') {
            // The usage event comes just before the turn's end: the turn began `durationMs` earlier.
            const endAt = ms(events[i + 1]!.at)
            const startAt = at - ev.durationMs
            for (const id of [...openTools.keys()]) closeTool(id, endAt)
            closeTurn(endAt, startAt)
            i++
          }
        }
        break
      case 'turn_end':
        for (const id of [...openTools.keys()]) closeTool(id, at)
        if (turnStart !== null) closeTurn(at)
        break
      default:
        if (TURN_CLOSES.has(ev.kind)) {
          for (const id of [...openTools.keys()]) closeTool(id, at)
          if (turnStart !== null) closeTurn(at)
        }
    }
  }
  for (const id of [...openTools.keys()]) closeTool(id, end)
  if (turnStart !== null) closeTurn(end)

  for (const t of turns) {
    const iv = clip(t.s, t.e)
    if (iv) intervals[TURN]!.push(iv)
  }

  // Sweep: at each stretch the highest-priority category covering it gets it. Tools of one category overlap freely, so parallel calls count once.
  const points: [number, number, number][] = []
  for (const [idx, list] of intervals.entries()) for (const iv of list) points.push([iv.s, idx, 1], [iv.e, idx, -1])
  points.sort((a, b) => a[0] - b[0])
  const counts = new Array<number>(PRIORITY.length + 1).fill(0)
  const byCategory = emptyCategoryMs()
  let cur = start
  const attribute = (to: number): void => {
    if (to <= cur) return
    const top = counts.findIndex((c, idx) => idx < TURN && c > 0)
    const cat: TimeCategory = top >= 0 ? PRIORITY[top]! : counts[TURN]! > 0 ? 'model' : 'between'
    byCategory[cat] += to - cur
    cur = to
  }
  for (const [t, idx, delta] of points) {
    attribute(t)
    counts[idx]! += delta
  }
  attribute(end)

  let turnCheck: TurnCheck | null = null
  if (hasUsage) {
    const computedMs = loggedMs
    turnCheck = { recordedMs, computedMs, disagrees: Math.abs(recordedMs - computedMs) > Math.max(60_000, 0.2 * recordedMs) }
  }

  return {
    runId: run.id,
    ticketRunId: run.ticketRunId,
    role: run.role,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    totalMs: end - start,
    byCategory,
    commands: [...commands.values()].sort((a, b) => b.ms - a.ms),
    turnCheck
  }
}

// --- A ticket ---

export interface RoleTime {
  role: string
  /** How many agent runs of the role were merged (replacements, hand-backs). */
  runs: number
  totalMs: number
  byCategory: CategoryMs
}

export interface RunGroupTime {
  ticketRunId: string
  /** Run 1, 2, ... in the order the runs were given. */
  n: number
  totalMs: number
  byCategory: CategoryMs
  roles: RoleTime[]
}

export interface TicketTime {
  totalMs: number
  byCategory: CategoryMs
  /** From the first agent run's start to the first ticket run that reached Review; null when none has. */
  toReviewMs: number | null
  runCount: number
  roleCount: number
  runs: RunGroupTime[]
  /** Every agent run, for the CSV and the cross-check. */
  agentRuns: RunTime[]
  /** The five commands that took longest in total. */
  commands: CommandTime[]
  /** Runs whose recorded turn durations and the log's turns differ a lot. */
  turnChecks: { role: string; check: TurnCheck }[]
}

export interface TicketRunInput {
  id: string
  status: 'running' | 'done' | 'stopped' | 'failed'
  endedAt: string | null
}

function addInto(into: CategoryMs, from: CategoryMs): void {
  for (const c of TIME_CATEGORIES) into[c.id] += from[c.id]
}

export function mergeCommands(lists: CommandTime[][], limit: number): CommandTime[] {
  const all = new Map<string, CommandTime>()
  for (const list of lists)
    for (const c of list) {
      const cur = all.get(c.command) ?? { command: c.command, count: 0, ms: 0, waitedMs: 0 }
      cur.count += c.count
      cur.ms += c.ms
      cur.waitedMs += c.waitedMs
      all.set(c.command, cur)
    }
  return [...all.values()].sort((a, b) => b.ms - a.ms || b.count - a.count).slice(0, limit)
}

export function ticketTime(input: {
  runs: TimeRunInput[]
  events: StoredEvent[]
  decisions: Decision[]
  ticketRuns: TicketRunInput[]
  now: number
}): TicketTime {
  const { runs, now } = input
  const eventsByRun = new Map<string, StoredEvent[]>()
  for (const e of input.events) {
    const list = eventsByRun.get(e.runId) ?? []
    list.push(e)
    eventsByRun.set(e.runId, list)
  }
  const agentRuns = runs.map((run) => runBreakdown({ run, events: eventsByRun.get(run.id) ?? [], decisions: input.decisions, now }))

  const order: string[] = []
  for (const r of runs) if (!order.includes(r.ticketRunId)) order.push(r.ticketRunId)
  const groups: RunGroupTime[] = order.map((ticketRunId, i) => {
    const group: RunGroupTime = { ticketRunId, n: i + 1, totalMs: 0, byCategory: emptyCategoryMs(), roles: [] }
    for (const r of agentRuns.filter((x) => x.ticketRunId === ticketRunId)) {
      let role = group.roles.find((x) => x.role === r.role)
      if (!role) {
        role = { role: r.role, runs: 0, totalMs: 0, byCategory: emptyCategoryMs() }
        group.roles.push(role)
      }
      role.runs++
      role.totalMs += r.totalMs
      addInto(role.byCategory, r.byCategory)
      group.totalMs += r.totalMs
      addInto(group.byCategory, r.byCategory)
    }
    return group
  })

  const byCategory = emptyCategoryMs()
  for (const g of groups) addInto(byCategory, g.byCategory)
  const first = runs.length > 0 ? Math.min(...runs.map((r) => ms(r.startedAt))) : null
  const reached = input.ticketRuns.filter((t) => t.status === 'done' && t.endedAt !== null).map((t) => ms(t.endedAt!))
  const toReviewMs = first !== null && reached.length > 0 ? Math.max(0, Math.min(...reached) - first) : null

  return {
    totalMs: groups.reduce((sum, g) => sum + g.totalMs, 0),
    byCategory,
    toReviewMs,
    runCount: groups.length,
    roleCount: new Set(runs.map((r) => r.role)).size,
    runs: groups,
    agentRuns,
    commands: mergeCommands(agentRuns.map((r) => r.commands), 5),
    turnChecks: agentRuns.flatMap((r) => (r.turnCheck?.disagrees ? [{ role: r.role, check: r.turnCheck }] : []))
  }
}

// --- A workspace ---

export interface TimedTicket {
  ticketId: string
  number: number
  title: string
  time: TicketTime
}

export interface RoleReport {
  role: string
  /** In how many of the tickets the role ran. */
  tickets: number
  totalMs: number
  byCategory: CategoryMs
}

export interface WorkspaceTimeReport {
  tickets: TimedTicket[]
  ticketCount: number
  totalMs: number
  byCategory: CategoryMs
  /** Per category, the mean over the tickets. */
  averages: CategoryMs
  averageMs: number
  roles: RoleReport[]
  medianToReviewMs: number | null
  commands: CommandTime[]
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export function workspaceTimeReport(tickets: TimedTicket[]): WorkspaceTimeReport {
  const n = tickets.length
  const byCategory = emptyCategoryMs()
  const roles = new Map<string, RoleReport>()
  for (const t of tickets) {
    addInto(byCategory, t.time.byCategory)
    const seen = new Set<string>()
    for (const g of t.time.runs)
      for (const r of g.roles) {
        let role = roles.get(r.role)
        if (!role) {
          role = { role: r.role, tickets: 0, totalMs: 0, byCategory: emptyCategoryMs() }
          roles.set(r.role, role)
        }
        if (!seen.has(r.role)) role.tickets++
        seen.add(r.role)
        role.totalMs += r.totalMs
        addInto(role.byCategory, r.byCategory)
      }
  }
  const averages = emptyCategoryMs()
  for (const c of TIME_CATEGORIES) averages[c.id] = n === 0 ? 0 : byCategory[c.id] / n
  const totalMs = tickets.reduce((sum, t) => sum + t.time.totalMs, 0)
  return {
    tickets,
    ticketCount: n,
    totalMs,
    byCategory,
    averages,
    averageMs: n === 0 ? 0 : totalMs / n,
    roles: [...roles.values()],
    medianToReviewMs: median(tickets.flatMap((t) => (t.time.toReviewMs !== null ? [t.time.toReviewMs] : []))),
    commands: mergeCommands(tickets.map((t) => t.time.commands), 10)
  }
}

// --- Text ---

/** "45 s", "31 min", "1 h 05 min". */
export function formatMinutes(durationMs: number): string {
  const s = Math.round(durationMs / 1000)
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

/** The exact minutes, for a tooltip: "12.3 min". */
export function exactMinutes(durationMs: number): string {
  return `${(durationMs / 60_000).toFixed(1)} min`
}

export function commandLine(c: CommandTime): string {
  const waited = c.waitedMs > 0 ? `, waited ${formatMinutes(c.waitedMs)} for approval` : ''
  return `${c.command} × ${c.count}, ${formatMinutes(c.ms)}${waited}`
}

/** The categories with time, largest first, as "Tests 12 min, Model 8 min". */
export function categoryLine(byCategory: CategoryMs): string {
  return TIME_CATEGORIES.filter((c) => byCategory[c.id] > 0)
    .sort((a, b) => byCategory[b.id] - byCategory[a.id])
    .map((c) => `${c.label} ${formatMinutes(byCategory[c.id])}`)
    .join(', ')
}

function csvField(value: string): string {
  // Titles are the user's text: a leading = + - or @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** One row per agent run and category that has time. */
export function timeReportCsv(report: Pick<WorkspaceTimeReport, 'tickets'>): string {
  const rows: string[][] = [['ticket', 'title', 'run', 'role', 'agent_run_id', 'started_at', 'ended_at', 'category', 'minutes']]
  for (const t of report.tickets) {
    const runNumber = new Map(t.time.runs.map((g) => [g.ticketRunId, g.n]))
    for (const r of t.time.agentRuns)
      for (const c of TIME_CATEGORIES) {
        const v = r.byCategory[c.id]
        if (v <= 0) continue
        rows.push([`#${t.number}`, t.title, String(runNumber.get(r.ticketRunId) ?? ''), r.role, r.runId, r.startedAt, r.endedAt ?? '', c.label, (v / 60_000).toFixed(2)])
      }
  }
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n'
}
