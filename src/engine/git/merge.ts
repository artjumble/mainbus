import fs from 'node:fs'
import path from 'node:path'
import type { PullRequest, Ticket, Workspace } from '../../shared/domain'
import type { MergePlan, MergePreview, MergeSuggestion } from '../../shared/merge'
import { SUGGESTION_TEXT } from '../../shared/merge'
import type { CommandOutput, CommandRunner } from './command'
import { NO_PROMPTS, PR_COMMAND_TIMEOUT_MS, firstLines } from './pullRequests'

/** git must never open an editor for a merge message; the message is given with -m. */
const MERGE_ENV = { ...NO_PROMPTS, GIT_MERGE_AUTOEDIT: 'no' }
/** How many paths a refusal names. */
const PATHS_SHOWN = 4

type Subject = Pick<Workspace, 'repoPath' | 'baseBranch' | 'mergeMethod'>
type Merged = Pick<Ticket, 'number' | 'title' | 'branch' | 'pr'>

/**
 * Merges a ticket's branch into the base for the user's Merge…: through its pull request with gh, or, locally, with a
 * fast-forward or a merge commit. It only acts on a plan the user has seen, and never forces, resets, rebases, pushes
 * or stashes anything: git itself refuses what isn't a fast-forward or a clean merge. Every call goes through the
 * command runner, so a test can see each one.
 */
export class BranchMerger {
  constructor(
    private readonly run: CommandRunner,
    private readonly timeoutMs = PR_COMMAND_TIMEOUT_MS
  ) {}

  /** What merging would do, or why it can't. Changes nothing. */
  async preview(ws: Subject, ticket: Merged): Promise<MergePreview> {
    const branch = ticket.branch
    if (branch === null) return refuse(`#${ticket.number} has no branch yet`)
    if (branch.startsWith('-') || ws.baseBranch.startsWith('-')) {
      return refuse(`the branch name ${branch.startsWith('-') ? branch : ws.baseBranch} is not one Mainbus can merge`)
    }
    const repo = ws.repoPath
    const head = await this.resolve(repo, `refs/heads/${branch}`)
    if (head === null) return refuse(`The branch ${branch} no longer exists`)

    if (ticket.pr !== null && (await this.git(['remote', 'get-url', 'origin'], repo)).code === 0) {
      return { ok: true, plan: { kind: 'pull_request', base: ws.baseBranch, branch, pr: ticket.pr, method: ws.mergeMethod, head } }
    }
    return this.previewLocal(ws, ticket, branch, head)
  }

  private async previewLocal(ws: Subject, ticket: Merged, branch: string, head: string): Promise<MergePreview> {
    const repo = ws.repoPath
    const base = ws.baseBranch
    const baseRef = `refs/heads/${base}`
    if ((await this.resolve(repo, baseRef)) === null) return refuse(`The base branch ${base} doesn't exist in your repository`)
    const counted = await this.git(['rev-list', '--count', `${baseRef}..refs/heads/${branch}`], repo)
    const commits = Number.parseInt(counted.stdout.trim(), 10)
    if (counted.code !== 0 || !Number.isInteger(commits)) {
      return refuse(`git could not compare ${branch} with ${base}: ${firstLines(counted.stderr)}`)
    }
    if (commits === 0) return refuse(`#${ticket.number}'s branch has nothing ${base} doesn't have; move it to Done instead`)

    const where = await this.checkedOutAt(repo, base)
    if (where !== null && !samePath(where, repo)) {
      return refuse(`${base} is checked out in ${where}, not in your checkout; Mainbus won't change another folder`)
    }
    const canFastForward = (await this.git(['merge-base', '--is-ancestor', baseRef, `refs/heads/${branch}`], repo)).code === 0
    const local = { kind: 'local' as const, base, branch, head, commits }

    if (where === null) {
      // Nobody has the base checked out: only its ref moves, and git refuses anything but a fast-forward.
      if (!canFastForward) return refuse(`${base} has commits ${branch} doesn't have, so it can't fast-forward`, 'update_from_main')
      const current = await this.git(['symbolic-ref', '--short', 'HEAD'], repo)
      const currentBranch = current.code === 0 ? current.stdout.trim() : null
      return { ok: true, plan: { ...local, how: 'fast_forward_ref', checkout: null, currentBranch, message: null } }
    }

    const status = await this.git(['status', '--porcelain', '--untracked-files=normal'], repo)
    if (status.code !== 0) return refuse(`git could not read the state of your checkout: ${firstLines(status.stderr)}`)
    const dirty = status.stdout.split(/\r?\n/).filter((l) => l.trim() !== '')
    if (dirty.length > 0) {
      const names = dirty.map((l) => l.slice(3).trim())
      const more = names.length > PATHS_SHOWN ? ` and ${names.length - PATHS_SHOWN} more` : ''
      return refuse(`Your checkout (${repo}) has uncommitted changes: ${names.slice(0, PATHS_SHOWN).join(', ')}${more}`, 'commit_or_stash')
    }
    if (canFastForward) return { ok: true, plan: { ...local, how: 'fast_forward', checkout: repo, currentBranch: base, message: null } }

    const merged = await this.git(['merge-tree', '--write-tree', '--name-only', '--no-messages', baseRef, `refs/heads/${branch}`], repo)
    if (merged.code === 1) {
      // The first line is the tree's id; the conflicting paths follow.
      const files = [...new Set(merged.stdout.split(/\r?\n/).slice(1).map((l) => l.trim()).filter((l) => l !== ''))]
      return refuse(`Merging ${branch} into ${base} would conflict in ${files.join(', ')}`, 'update_from_main')
    }
    if (merged.code !== 0) return refuse(`git could not check the merge: ${firstLines(merged.stderr)}`)
    return {
      ok: true,
      plan: { ...local, how: 'merge_commit', checkout: repo, currentBranch: base, message: `Merge #${ticket.number}: ${ticket.title}` }
    }
  }

  /**
   * Carries out a plan the user saw and returns the base's new commit (null for a pull request: nothing was fetched).
   * Throws with the reason when GitHub or git refuses; nothing is forced or undone.
   */
  async merge(ws: Subject, plan: MergePlan, opts: { deleteBranch: boolean }): Promise<string | null> {
    const repo = ws.repoPath
    if (plan.kind === 'pull_request') {
      await this.mergePullRequest(repo, plan, opts.deleteBranch)
      return null
    }
    const branchRef = `refs/heads/${plan.branch}`
    if (plan.how === 'fast_forward') {
      await this.mustGit(['merge', '--ff-only', branchRef], repo, `git could not fast-forward ${plan.base}`)
    } else if (plan.how === 'merge_commit') {
      const out = await this.git(['merge', '--no-ff', '-m', plan.message ?? `Merge ${plan.branch}`, branchRef], repo)
      if (out.code !== 0) {
        throw new Error(
          `git could not merge ${plan.branch} into ${plan.base}: ${firstLines(out.stderr || out.stdout) || `exit code ${out.code}`}. ` +
            `If your checkout is left mid-merge, run "git merge --abort" in ${repo}.`
        )
      }
    } else {
      // No "+" on the refspec: git refuses anything but a fast-forward.
      await this.mustGit(
        ['fetch', '--no-tags', '--no-write-fetch-head', '.', `${branchRef}:refs/heads/${plan.base}`],
        repo,
        `git could not fast-forward ${plan.base}`
      )
    }
    return this.resolve(repo, `refs/heads/${plan.base}`)
  }

  private async mergePullRequest(repo: string, plan: Extract<MergePlan, { kind: 'pull_request' }>, deleteBranch: boolean): Promise<void> {
    const target = repoOfUrl(plan.pr.url)
    if (target === null) throw new Error(`The pull request's address ${plan.pr.url} isn't one Mainbus can merge`)
    // --repo makes gh skip its local work (deleting the local branch, checking out the base): the user's checkout isn't touched.
    // --match-head-commit makes GitHub refuse if the branch moved since the user looked.
    const args = ['pr', 'merge', String(plan.pr.number), `--${plan.method}`, `--repo=${target}`, `--match-head-commit=${plan.head}`]
    if (deleteBranch) args.push('--delete-branch')
    const merged = await this.gh(args, repo)
    if (merged.code !== 0) throw new Error(`GitHub refused the merge: ${firstLines(merged.stderr) || `exit code ${merged.code}`}`)
    // A merge queue or auto-merge answers success without having merged.
    const viewed = await this.gh(['pr', 'view', String(plan.pr.number), '--json', 'state', `--repo=${target}`], repo)
    let state: unknown = null
    try {
      state = (JSON.parse(viewed.stdout) as { state?: unknown }).state
    } catch {
      // Not JSON: treated as not merged below.
    }
    if (viewed.code !== 0 || state !== 'MERGED') {
      throw new Error(`GitHub hasn't merged pull request #${plan.pr.number} yet (it may be queued or waiting for checks); look at it on GitHub`)
    }
  }

  /** The path of the worktree that has `base` checked out, or null when none does. */
  private async checkedOutAt(repo: string, base: string): Promise<string | null> {
    const out = await this.git(['worktree', 'list', '--porcelain'], repo)
    if (out.code !== 0) return null
    for (const block of out.stdout.split(/\r?\n\r?\n/)) {
      const lines = block.split(/\r?\n/)
      const dir = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length)
      if (dir && lines.includes(`branch refs/heads/${base}`)) return dir
    }
    return null
  }

  private async resolve(repo: string, ref: string): Promise<string | null> {
    const out = await this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repo)
    return out.code === 0 ? out.stdout.trim() : null
  }

  private async mustGit(args: string[], cwd: string, what: string): Promise<void> {
    const out = await this.git(args, cwd)
    if (out.code !== 0) throw new Error(`${what}: ${firstLines(out.stderr || out.stdout) || `exit code ${out.code}`}`)
  }

  private git(args: string[], cwd: string): Promise<CommandOutput> {
    return this.exec('git', args, cwd)
  }

  private gh(args: string[], cwd: string): Promise<CommandOutput> {
    return this.exec('gh', args, cwd)
  }

  private async exec(file: 'git' | 'gh', args: string[], cwd: string): Promise<CommandOutput> {
    let out: CommandOutput
    try {
      out = await this.run(file, args, { cwd, env: MERGE_ENV, timeoutMs: this.timeoutMs })
    } catch (err) {
      throw new Error(file === 'gh' ? 'the GitHub CLI (gh) is not installed' : `git could not be started: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (out.timedOut) throw new Error(`${file} ${args[0]} timed out after ${Math.round(this.timeoutMs / 1000)} seconds`)
    return out
  }
}

function refuse(reason: string, suggest: MergeSuggestion | null = null): MergePreview {
  return { ok: false, reason, suggest }
}

/** A refusal as one sentence for an error: the reason and what to do about it. */
export function refusalText(p: Extract<MergePreview, { ok: false }>): string {
  return p.suggest === null ? p.reason : `${p.reason}. ${SUGGESTION_TEXT[p.suggest]}`
}

/** `HOST/OWNER/REPO` of a pull request's address, for gh's --repo; null when it isn't an https address with an owner and repo. */
export function repoOfUrl(url: PullRequest['url']): string | null {
  try {
    const u = new URL(url)
    const [owner, repo] = u.pathname.split('/').filter((s) => s !== '')
    if (u.protocol !== 'https:' || !owner || !repo) return null
    return `${u.host}/${owner}/${repo}`
  } catch {
    return null
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    let r = path.resolve(p)
    try {
      // Git reports long, real paths; the workspace's may be a short name or a link.
      r = fs.realpathSync.native(r)
    } catch {
      // A path that can't be resolved is compared as written.
    }
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}
