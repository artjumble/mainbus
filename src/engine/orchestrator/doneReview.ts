import { categoryLine, commandLine, formatMinutes } from '../../shared/timeBreakdown'
import { mergedText } from '../../shared/merge'
import { outcome as decisionOutcome } from '../runner/digest'
import { data, oneLine } from '../roles/prompt'
import type { Repos } from '../store'
import { ticketTimeFor } from '../time/report'
import { wsTag } from './workspaceRef'
import type { Ticket } from '../../shared/domain'

/** The most characters one finished ticket's block takes in the orchestrator's prompt, tags included. */
export const DONE_REVIEW_BUDGET = 1500

/** What the orchestrator is told about a ticket that reached Done: the engine's reading of its history, as data. */
export interface DoneReview {
  ticketId: string
  workspaceId: string
  workspace?: string
  number: number
  title: string
  kind: string
  /** The user's own words (the intent entries with no source). */
  userWords: string[]
  /** Each role's last handoff, oldest role first. */
  handoffs: { role: string; summary: string; notesForNext?: string; skipped?: boolean }[]
  /** The hand-backs between roles: the Reviewer's findings live here and in its summary. */
  handBacks: { from: string; to: string; details: string }[]
  uncheckedCriteria: string[]
  /** The questions the agents asked and what the user answered. */
  decisions: { question: string; answer: string }[]
  /** Permission requests, counted only. */
  permissionRequests: number
  stuckEpisodes: number
  replacements: number
  pr: { number: number; url: string } | null
  merged: string | null
  /** The Time report's headline, or null when the ticket has no recorded time. */
  time: string | null
  /** Tickets this one unblocked: not Done, and every blocker is now Done. */
  unblocked: { number: number; title: string }[]
}

export type DoneReviewRepos = Pick<Repos, 'runs' | 'decisions' | 'tickets' | 'stuck' | 'dependencies'>

/** The headline of the Time report: the total, the three biggest categories and the longest command. */
function timeHeadline(time: Awaited<ReturnType<typeof ticketTimeFor>>): string | null {
  if (time.runCount === 0) return null
  const parts = [`${formatMinutes(time.totalMs)} over ${time.runCount} ${time.runCount === 1 ? 'run' : 'runs'}`]
  const top = categoryLine(time.byCategory).split(', ').filter(Boolean).slice(0, 3)
  if (top.length > 0) parts.push(`most on ${top.join(', ')}`)
  const longest = time.commands[0]
  if (longest) parts.push(`longest command: ${commandLine(longest)}`)
  return parts.join('; ')
}

/** Everything the review of a finished ticket is built from. Read-only. */
export async function doneReviewOf(repos: DoneReviewRepos, ticket: Ticket, workspace?: string): Promise<DoneReview> {
  const runs = await repos.runs.listForTicket(ticket.id)
  const events = await Promise.all(runs.map(async (run) => ({ run, events: await repos.runs.events(run.id) })))
  const lastByRole = new Map<string, DoneReview['handoffs'][number]>()
  const handBacks: DoneReview['handBacks'] = []
  let merged: string | null = null
  for (const { run, events: stored } of events) {
    for (const { event } of stored) {
      if (event.kind === 'handoff') {
        lastByRole.delete(run.role)
        lastByRole.set(run.role, {
          role: run.role,
          summary: event.summary,
          ...(event.notesForNext ? { notesForNext: event.notesForNext } : {}),
          ...(event.skipped ? { skipped: true } : {})
        })
      } else if (event.kind === 'hand_back') {
        handBacks.push({ from: event.from, to: event.to, details: event.details })
      } else if (event.kind === 'merged') {
        merged = mergedText(event)
      }
    }
  }
  const decisions = await repos.decisions.forTicket(ticket.id)
  const questions = decisions.filter((d) => d.kind === 'question')
  const unblocked: DoneReview['unblocked'] = []
  for (const dependentId of await repos.dependencies.dependentsOf(ticket.id)) {
    const dependent = await repos.tickets.get(dependentId).catch(() => null)
    if (!dependent || dependent.manualColumn === 'done') continue
    const blockers = await repos.dependencies.blockersOf(dependentId)
    if (blockers.length > 0 && blockers.every((b) => b.done)) unblocked.push({ number: dependent.number, title: dependent.title })
  }
  const time = await ticketTimeFor(repos, ticket.id).catch(() => null)
  return {
    ticketId: ticket.id,
    workspaceId: ticket.workspaceId,
    ...(workspace === undefined ? {} : { workspace }),
    number: ticket.number,
    title: ticket.title,
    kind: ticket.kind,
    userWords: ticket.intent.filter((e) => e.source === undefined).map((e) => e.text),
    handoffs: [...lastByRole.values()],
    handBacks,
    uncheckedCriteria: ticket.criteria.filter((c) => !c.checked).map((c) => c.text),
    decisions: questions.map((d) => ({ question: d.question, answer: decisionOutcome(d) })),
    permissionRequests: decisions.length - questions.length,
    stuckEpisodes: (await repos.stuck.forRuns(runs.map((r) => r.id))).length,
    replacements: runs.filter((r) => r.endReason === 'replaced').length,
    pr: ticket.pr ? { number: ticket.pr.number, url: ticket.pr.url } : null,
    merged,
    time: time === null ? null : timeHeadline(time),
    unblocked
  }
}

/** One line, at most `max` characters, with an ellipsis when it was cut. */
function clip(text: string, max: number): string {
  const flat = oneLine(text).trim()
  if (flat.length <= max) return flat
  return max <= 1 ? '' : `${flat.slice(0, max - 1)}…`
}

/** A section is worth adding only when this much of its text fits. */
const MIN_ROOM = 40

/**
 * The review as the orchestrator reads it, within DONE_REVIEW_BUDGET characters, tags included. Sections come in
 * priority order and each is clipped to the space left; what doesn't fit is left out. The texts of agents and the
 * user are data: clipped first, then wrapped, so no tag is ever cut.
 */
export function doneReviewText(r: DoneReview): string {
  const lines: string[] = []
  let used = 0
  const fits = (line: string): boolean => used + line.length + 1 <= DONE_REVIEW_BUDGET
  const add = (line: string): void => {
    if (!fits(line)) return
    lines.push(line)
    used += line.length + 1
  }
  /** `make` wraps the text; the text is clipped to what is left. */
  const addText = (make: (text: string) => string, text: string, max: number): void => {
    const room = Math.min(max, DONE_REVIEW_BUDGET - used - 1 - make('').length)
    if (room < Math.min(MIN_ROOM, text.length)) return
    let clipped = clip(text, room)
    // The escaping of a closing tag in the data adds characters.
    while (clipped !== '' && !fits(make(clipped))) clipped = clip(clipped, clipped.length - (used + make(clipped).length + 1 - DONE_REVIEW_BUDGET))
    if (clipped !== '') add(make(clipped))
  }
  const field = (name: string) => (text: string) => data(name, text, true)

  addText((t) => `#${r.number} ${data('title', t, true)}${wsTag(r.workspace)}: reached Done`, r.title, 120)
  const stats = [
    r.handBacks.length > 0 ? `${r.handBacks.length} ${r.handBacks.length === 1 ? 'hand-back' : 'hand-backs'}` : null,
    r.stuckEpisodes > 0 ? `${r.stuckEpisodes} stuck ${r.stuckEpisodes === 1 ? 'episode' : 'episodes'}` : null,
    r.replacements > 0 ? `${r.replacements} ${r.replacements === 1 ? 'replacement' : 'replacements'}` : null,
    r.permissionRequests > 0 ? `${r.permissionRequests} permission ${r.permissionRequests === 1 ? 'request' : 'requests'}` : null,
    r.pr ? `pull request #${r.pr.number}` : 'no pull request',
    r.merged
  ].filter((s) => s !== null)
  addText((t) => `Facts: ${t}`, stats.join('; '), 300)
  if (r.time) addText((t) => `Time report headline: ${field('time')(t)}`, r.time, 200)
  for (const u of r.unblocked) {
    addText((t) => `Now unblocked and ready to start: #${u.number} ${data('title', t, true)}`, u.title, 120)
  }
  for (const h of [...r.handoffs].reverse()) {
    if (h.notesForNext) addText((t) => `Notes the ${oneLine(h.role)} left for the next role: ${field('notes-for-next')(t)}`, h.notesForNext, 450)
  }
  for (const c of r.uncheckedCriteria) addText((t) => `Criterion left unticked: ${field('criterion')(t)}`, c, 200)
  for (const b of r.handBacks) {
    addText((t) => `${oneLine(b.from)} handed back to ${oneLine(b.to)}: ${field('hand-back')(t)}`, b.details, 300)
  }
  const last = r.handoffs.at(-1)
  if (last) addText((t) => `The ${oneLine(last.role)}'s final summary${last.skipped ? ' (written by Mainbus, the role was skipped)' : ''}: ${field('summary')(t)}`, last.summary, 350)
  for (const d of r.decisions) {
    addText((t) => `The user was asked: ${field('question')(t)}`, `${d.question} → ${d.answer}`, 200)
  }
  for (const h of r.handoffs.slice(0, -1).reverse()) {
    addText((t) => `The ${oneLine(h.role)}'s summary: ${field('summary')(t)}`, h.summary, 200)
  }
  for (const w of r.userWords) addText((t) => `The user's words: ${field('user-words')(t)}`, w, 250)
  return lines.join('\n')
}

/** What the orchestrator looks for in a finished ticket, and how it acts on it. */
export const DONE_REVIEW_RUBRIC = [
  'Finished tickets to review. Each block below says what the ticket\'s agents left behind when it reached Done. Look for concrete follow-up work:',
  '- problems the agents found but left ("out of scope", "worth a ticket", "pre-existing failure");',
  '- acceptance criteria left unticked, and known limits they documented;',
  '- repeated friction (long permission waits, flaky or slow tests, stuck episodes);',
  '- the next step of a series of tickets;',
  '- tickets that are now unblocked and ready to start.',
  'Check before suggesting, for duplicates: compare each idea with the open and recent Done tickets listed below (and with list_tickets or search when unsure). Skip anything already covered, and name the existing ticket in your message when you do.',
  'Never act without the user. Propose a follow-up ticket with propose_create_tickets: set follow_up_of to the number of the Done ticket it follows up, and write a context that cites that ticket and the handoff it comes from. Never create tickets directly in this turn. Propose starting an unblocked ticket with propose_start.',
  'At most 3 follow-up tickets in this turn. If there are more, summarise the rest in one message, ranked.',
  'Stay quiet when there is nothing worth doing: propose nothing and write nothing, or at most one line such as "Reviewed #109, #110: no follow-ups."'
].join('\n')
