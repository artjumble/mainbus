import fs from 'node:fs/promises'
import path from 'node:path'
import { checkReportsFolder, type Ticket } from '../../shared/domain'
import type { CommandOutput, CommandRunner } from './command'
import { slugify } from './slug'

/** How long one git command may take before it is killed: a hook or a signing prompt must not hang it. */
export const REPORT_COMMAND_TIMEOUT_MS = 2 * 60 * 1000
/** Nothing Mainbus runs here may stop to ask for input. */
const NO_PROMPTS = { GIT_TERMINAL_PROMPT: '0' }
const REASON_MAX = 500

/** The date a report is saved on, as `YYYY-MM-DD` in the user's own time zone. */
export function reportDate(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** Where a ticket's report is saved, relative to the repo: `<folder>/<YYYY-MM-DD>-<n>-<slug>.md`. Throws on a refused folder. */
export function reportFilePath(folder: string, ticket: Pick<Ticket, 'number' | 'title'>, date: string): string {
  const checked = checkReportsFolder(folder)
  if (!checked.ok) throw new Error(checked.reason)
  return `${checked.folder}/${date}-${ticket.number}-${slugify(ticket.title)}.md`
}

/** "Investigation #<n>: <title>": the report's commit message, and its pull request's title. */
export function investigationTitle(ticket: Pick<Ticket, 'number' | 'title'>): string {
  return `Investigation #${ticket.number}: ${ticket.title.replace(/\s+/g, ' ').trim()}`
}

/** The file: a short header (the ticket, the date, the user's own words), then the report exactly as submitted. */
export function reportFileText(ticket: Pick<Ticket, 'number' | 'title' | 'intent'>, report: string, date: string): string {
  const words = ticket.intent.filter((e) => !e.source).map((e) => e.text.trim())
  // Each line of the words stays inside the quote block.
  const question = (words.length > 0 ? words.join('\n\n') : 'No words from the user.').split(/\r?\n/).join('\n> ')
  const header = [
    `> **Investigation #${ticket.number}:** ${ticket.title.replace(/\s+/g, ' ').trim()}`,
    `> **Date:** ${date} · **Status:** report, recommends but doesn't authorise changes`,
    `> **The question (the user's words):** ${question}`
  ].join('\n')
  return `${header}\n\n${report}${report.endsWith('\n') ? '' : '\n'}`
}

export interface SaveReportInput {
  worktreePath: string
  /** Relative to the worktree, with forward slashes. */
  relPath: string
  content: string
  message: string
}

export type SaveReportResult = { ok: true; commit: string } | { ok: false; reason: string }

/** Thrown inside `save` with the reason the user sees after "Couldn't save the report to the repo: ". */
class SaveFailure extends Error {}

/**
 * Writes an Investigate ticket's report into its worktree and commits that one file on the ticket's branch. Mainbus
 * runs this itself, never the agent, which stays read-only. The commit is the user's own git, with their identity and
 * hooks; nothing else in the worktree is staged or committed. A resubmitted report overwrites the file in a new commit,
 * even when nothing in it changed.
 */
export class ReportFileSaver {
  constructor(
    private readonly run: CommandRunner,
    private readonly timeoutMs = REPORT_COMMAND_TIMEOUT_MS
  ) {}

  async save(input: SaveReportInput): Promise<SaveReportResult> {
    try {
      return { ok: true, commit: await this.saveOrThrow(input) }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }

  private async saveOrThrow({ worktreePath, relPath, content, message }: SaveReportInput): Promise<string> {
    const root = await fs.realpath(worktreePath).catch(() => {
      throw new SaveFailure("the ticket's folder is missing")
    })
    const file = path.resolve(root, relPath)
    if (!isInside(file, root)) throw new SaveFailure(`${relPath} is outside the repository`)
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      // A folder in the repo may be a link to somewhere else: what it really is must still be inside.
      if (!isInside(await fs.realpath(path.dirname(file)), root)) throw new SaveFailure(`${relPath} is outside the repository`)
      await fs.writeFile(file, content, 'utf8')
    } catch (err) {
      if (err instanceof SaveFailure) throw err
      throw new SaveFailure(`the file could not be written: ${err instanceof Error ? err.message : String(err)}`)
    }

    // `--` so a path is never taken for an option. Only this file is staged and committed.
    await this.git(['add', '--', relPath], root, 'git add')
    await this.git(['commit', '--allow-empty', '-m', message, '--', relPath], root, 'git commit')
    return (await this.git(['rev-parse', 'HEAD'], root, 'git rev-parse')).stdout.trim()
  }

  private async git(args: string[], cwd: string, what: string): Promise<CommandOutput> {
    let out: CommandOutput
    try {
      out = await this.run('git', args, { cwd, env: NO_PROMPTS, timeoutMs: this.timeoutMs })
    } catch (err) {
      throw new SaveFailure(`git could not be started: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (out.timedOut) throw new SaveFailure(`${what} timed out`)
    if (out.code !== 0) throw new SaveFailure(`${what} failed: ${firstLines(out.stderr || out.stdout) || `exit code ${out.code}`}`)
    return out
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

function firstLines(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('hint:'))
  const joined = lines.slice(0, 3).join(' ')
  return joined.length <= REASON_MAX ? joined : `${joined.slice(0, REASON_MAX - 1)}…`
}
