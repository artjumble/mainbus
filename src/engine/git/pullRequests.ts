import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GhStatus, PullRequest, Ticket } from '../../shared/domain'
import type { CommandOutput, CommandRunner } from './command'
import { investigationTitle } from './reportFiles'

/** How long one git or gh command may take before it is killed: a credential prompt must not hang it. */
export const PR_COMMAND_TIMEOUT_MS = 2 * 60 * 1000

/** Nothing Mainbus runs here may stop to ask for input: no terminal prompt from git, no prompt from gh. */
const NO_PROMPTS = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' }

const GH_MISSING = 'the GitHub CLI (gh) is not installed'
const GH_SIGNED_OUT = 'the GitHub CLI (gh) is not signed in; run `gh auth login`'
const NO_ORIGIN = 'the repository has no origin remote'
const REASON_MAX = 500

export interface PublishInput {
  ticket: Ticket & { branch: string; worktreePath: string }
  baseBranch: string
  /** The agent's latest handoff summary, if there is one. */
  handoffSummary: string | null
}

export type PublishResult = { ok: true; pr: PullRequest; opened: boolean } | { ok: false; reason: string }

/** Thrown inside `publish` with the reason the user sees after "Couldn't open a PR: ". */
class PublishFailure extends Error {}

/**
 * Pushes a ticket's branch to origin and opens a ready-for-review pull request for it with the GitHub CLI.
 * Mainbus runs this itself, never the agent. It only ever pushes the ticket's own branch, never with force,
 * and it uses the user's own git credential helper and gh login: it never sees a token.
 */
export class PullRequestPublisher {
  constructor(
    private readonly run: CommandRunner,
    private readonly timeoutMs = PR_COMMAND_TIMEOUT_MS
  ) {}

  /** Whether gh is installed and signed in. Its output is never passed on: `gh auth status` can show a token. */
  async checkGh(cwd: string): Promise<GhStatus> {
    try {
      await this.gh(['--version'], cwd, 'gh --version')
      await this.gh(['auth', 'status'], cwd, 'gh auth status', GH_SIGNED_OUT)
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: reasonOf(err) }
    }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    try {
      return { ok: true, ...(await this.publishOrThrow(input)) }
    } catch (err) {
      return { ok: false, reason: reasonOf(err) }
    }
  }

  private async publishOrThrow({ ticket, baseBranch, handoffSummary }: PublishInput): Promise<{ pr: PullRequest; opened: boolean }> {
    const { branch, worktreePath: cwd } = ticket
    if (branch.startsWith('-')) throw new PublishFailure(`the branch name ${branch} is not one Mainbus can push`)

    const origin = await this.git(['remote', 'get-url', 'origin'], cwd, 'git remote get-url origin')
    if (origin.code !== 0) throw new PublishFailure(NO_ORIGIN)
    // Checked before pushing, so a missing gh doesn't leave a pushed branch with no PR.
    if (ticket.pr === null) {
      const gh = await this.checkGh(cwd)
      if (!gh.ok) throw new PublishFailure(gh.reason)
    }

    // Only the ticket's own branch, and never with force: a rejected push is reported, not overridden.
    const push = await this.git(['push', '-u', 'origin', branch], cwd, 'git push')
    if (push.code !== 0) throw new PublishFailure(`git push failed: ${firstLines(push.stderr) || `exit code ${push.code}`}`)

    // Pushing updates the PR opened in an earlier round; its title and body are left as they are.
    if (ticket.pr !== null) return { pr: ticket.pr, opened: false }
    return { pr: await this.createPr(ticket, baseBranch, handoffSummary), opened: true }
  }

  private async createPr(ticket: PublishInput['ticket'], baseBranch: string, handoffSummary: string | null): Promise<PullRequest> {
    const { branch, worktreePath: cwd } = ticket
    // The body goes through a file: it is free text, and a command line has a length limit.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-pr-'))
    try {
      const bodyFile = path.join(dir, 'body.md')
      await fs.writeFile(bodyFile, prBody(ticket, handoffSummary), 'utf8')
      // `--flag=value`, so a title that starts with "-" is still a title. No --draft: the PR is ready for review.
      const created = await this.gh(
        ['pr', 'create', `--base=${baseBranch}`, `--head=${branch}`, `--title=${prTitle(ticket)}`, `--body-file=${bodyFile}`],
        cwd,
        'gh pr create',
        null
      )
      if (created.code === 0) {
        const pr = prFromUrl(created.stdout)
        if (pr) return pr
      } else if (!/already exists/i.test(created.stderr)) {
        throw new PublishFailure(`gh pr create failed: ${firstLines(created.stderr) || `exit code ${created.code}`}`)
      }
      // A PR for this branch already exists (or gh printed no URL): adopt it.
      return await this.viewPr(branch, cwd)
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  private async viewPr(branch: string, cwd: string): Promise<PullRequest> {
    const viewed = await this.gh(['pr', 'view', branch, '--json', 'url,number'], cwd, 'gh pr view', null)
    if (viewed.code !== 0) throw new PublishFailure(`gh pr view failed: ${firstLines(viewed.stderr) || `exit code ${viewed.code}`}`)
    let parsed: unknown
    try {
      parsed = JSON.parse(viewed.stdout)
    } catch {
      throw new PublishFailure('gh pr view did not answer with the pull request')
    }
    const { url, number } = (parsed ?? {}) as { url?: unknown; number?: unknown }
    if (typeof url !== 'string' || !isHttps(url) || typeof number !== 'number' || !Number.isInteger(number)) {
      throw new PublishFailure('gh pr view did not answer with the pull request')
    }
    return { url, number }
  }

  private async git(args: string[], cwd: string, what: string): Promise<CommandOutput> {
    let out: CommandOutput
    try {
      out = await this.run('git', args, { cwd, env: NO_PROMPTS, timeoutMs: this.timeoutMs })
    } catch (err) {
      throw new PublishFailure(`git could not be started: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (out.timedOut) throw new PublishFailure(`${what} timed out after ${minutes(this.timeoutMs)}`)
    return out
  }

  /**
   * Runs gh. With `failure` set, a non-zero exit throws it (or the first lines of gh's error, by default);
   * with null, the caller looks at the exit code itself.
   */
  private async gh(args: string[], cwd: string, what: string, failure?: string | null): Promise<CommandOutput> {
    let out: CommandOutput
    try {
      out = await this.run('gh', args, { cwd, env: NO_PROMPTS, timeoutMs: this.timeoutMs })
    } catch {
      throw new PublishFailure(GH_MISSING)
    }
    if (out.timedOut) throw new PublishFailure(`${what} timed out after ${minutes(this.timeoutMs)}`)
    if (out.code !== 0 && failure !== null) {
      throw new PublishFailure(failure ?? `${what} failed: ${firstLines(out.stderr) || `exit code ${out.code}`}`)
    }
    return out
  }
}

/** The PR's title: the ticket's, or "Investigation #<n>: <title>" for an Investigate ticket. */
export function prTitle(ticket: Ticket): string {
  return ticket.kind === 'investigate' ? investigationTitle(ticket) : ticket.title
}

/**
 * The PR description: the user's own words, the handoff summary (or, for an Investigate ticket, where its report is
 * saved), the criteria as a checklist, and the ticket.
 */
export function prBody(ticket: Ticket, handoffSummary: string | null): string {
  const words = ticket.intent.filter((e) => !e.source).map((e) => e.text.trim())
  const parts = ['## In your words', words.length > 0 ? words.join('\n\n') : '_No words from the user yet._']
  if (handoffSummary !== null && handoffSummary.trim() !== '') parts.push('## Handoff', handoffSummary.trim())
  if (ticket.kind === 'investigate' && ticket.reportFile !== null) parts.push('## Report', `Saved as \`${ticket.reportFile}\`.`)
  if (ticket.criteria.length > 0) {
    parts.push('## Acceptance criteria', ticket.criteria.map((c) => `- [${c.checked ? 'x' : ' '}] ${c.text}`).join('\n'))
  }
  parts.push('---', `Mainbus ticket #${ticket.number}`)
  return `${parts.join('\n\n')}\n`
}

function prFromUrl(text: string): PullRequest | null {
  for (const line of text.split(/\r?\n/).reverse()) {
    const url = line.trim()
    const match = /^https:\/\/\S+\/pull\/(\d+)$/.exec(url)
    if (match) return { url, number: Number(match[1]) }
  }
  return null
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/** The lines of git's or gh's error output worth showing, without any credentials in remote URLs. */
function firstLines(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^(To |hint:)/.test(l))
  const text = lines.slice(0, 3).join(' ').replace(/(\w+:\/\/)[^\s/@]+@/g, '$1')
  return text.length <= REASON_MAX ? text : `${text.slice(0, REASON_MAX - 1)}…`
}

function minutes(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}` : `${Math.round(ms / 1000)} seconds`
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
