import type { Workspace } from '../../shared/domain'
import type { CommandRunner } from './command'
import type { GitRunner } from './git'
import { NO_PROMPTS, firstLines } from './pullRequests'

/** How long a fetch may take before it is killed: a credential prompt must not hang it. */
export const FETCH_TIMEOUT_MS = 60 * 1000

const NO_ORIGIN = 'the repository has no origin remote'

export interface NewestBase {
  /** The ref to branch from or compare with: `origin/<base>` when it is ahead of the local base, else the local base. */
  ref: string
  sha: string
  /** What to tell the user when the local base had to stand in because a newer one couldn't be fetched, else null. */
  notice: string | null
  /** Why the fetch failed (or there is no origin), else null. Set only when a fetch was asked for. */
  fetchError: string | null
}

export type FetchResult = { ok: true } | { ok: false; reason: string }

/**
 * Finds the newest state of a workspace's base branch and measures a ticket's branch against it. It never changes the
 * user's checkout or their local base branch: the only ref it moves is `refs/remotes/origin/<base>`, through a fetch.
 */
export class BranchFreshnessChecker {
  /** Fetches of the same repository run one at a time, so two never race on a ref lock. */
  private readonly fetches = new Map<string, Promise<unknown>>()

  constructor(
    private readonly git: GitRunner,
    private readonly commands: CommandRunner,
    private readonly timeoutMs = FETCH_TIMEOUT_MS
  ) {}

  /** `git fetch origin <base>` with the user's own login and no prompts. */
  fetchBase(ws: Pick<Workspace, 'repoPath' | 'baseBranch'>): Promise<FetchResult> {
    const previous = this.fetches.get(ws.repoPath) ?? Promise.resolve()
    const next = previous.then(() => this.fetchNow(ws))
    const tail = next.catch(() => {})
    this.fetches.set(ws.repoPath, tail)
    void tail.then(() => {
      if (this.fetches.get(ws.repoPath) === tail) this.fetches.delete(ws.repoPath)
    })
    return next
  }

  private async fetchNow({ repoPath, baseBranch }: Pick<Workspace, 'repoPath' | 'baseBranch'>): Promise<FetchResult> {
    if (baseBranch.startsWith('-')) return { ok: false, reason: `the base branch name ${baseBranch} is not one Mainbus can fetch` }
    let origin
    try {
      origin = await this.git(['remote', 'get-url', 'origin'], repoPath)
    } catch (err) {
      return { ok: false, reason: `git could not be started: ${errorText(err)}` }
    }
    if (origin.code !== 0) return { ok: false, reason: NO_ORIGIN }
    try {
      const out = await this.commands(
        'git',
        ['fetch', '--no-tags', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`],
        { cwd: repoPath, env: NO_PROMPTS, timeoutMs: this.timeoutMs }
      )
      if (out.timedOut) return { ok: false, reason: `git fetch timed out after ${Math.round(this.timeoutMs / 1000)} seconds` }
      if (out.code !== 0) return { ok: false, reason: `git fetch failed: ${firstLines(out.stderr) || `exit code ${out.code}`}` }
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: `git could not be started: ${errorText(err)}` }
    }
  }

  /**
   * The newest base: origin/<base> when it is ahead of the local base (the local one is an ancestor of it), else the
   * local base, which also stands when the two have diverged. `fetch` asks for a fresh fetch first.
   */
  async newestBase(ws: Pick<Workspace, 'repoPath' | 'baseBranch'>, opts: { fetch: boolean }): Promise<NewestBase> {
    const fetched = opts.fetch ? await this.fetchBase(ws) : null
    const fetchError = fetched !== null && !fetched.ok ? fetched.reason : null
    const local = `refs/heads/${ws.baseBranch}`
    const remote = `refs/remotes/origin/${ws.baseBranch}`
    const localSha = await this.resolve(ws.repoPath, local)
    const remoteSha = await this.resolve(ws.repoPath, remote)
    if (remoteSha !== null && localSha !== null && remoteSha !== localSha) {
      const ahead = await this.git(['merge-base', '--is-ancestor', local, remote], ws.repoPath)
      if (ahead.code === 0) return { ref: `origin/${ws.baseBranch}`, sha: remoteSha, notice: null, fetchError }
    }
    // A repo with a remote but no local base branch: the remote one is all there is.
    if (localSha === null && remoteSha !== null) return { ref: `origin/${ws.baseBranch}`, sha: remoteSha, notice: null, fetchError }
    return {
      ref: ws.baseBranch,
      sha: localSha ?? ws.baseBranch,
      notice:
        fetchError === null
          ? null
          : `This branch starts from your local ${ws.baseBranch}: ${fetchError}, so Mainbus couldn't fetch a newer one.`,
      fetchError
    }
  }

  /**
   * How many commits of `sha` the branch lacks, and the files that would conflict if `sha` were merged into it
   * (`git merge-tree`, which changes no working tree). Throws when git can't answer.
   */
  async check(repoPath: string, branch: string, sha: string): Promise<{ behind: number; conflicts: string[] }> {
    const head = `refs/heads/${branch}`
    const counted = await this.git(['rev-list', '--count', `${head}..${sha}`], repoPath)
    if (counted.code !== 0) throw new Error(`git rev-list failed: ${firstLines(counted.stderr)}`)
    const behind = Number.parseInt(counted.stdout.trim(), 10)
    if (!Number.isInteger(behind)) throw new Error('git rev-list gave no count')
    if (behind === 0) return { behind: 0, conflicts: [] }
    const merged = await this.git(['merge-tree', '--write-tree', '--name-only', '--no-messages', head, sha], repoPath)
    if (merged.code === 0) return { behind, conflicts: [] }
    if (merged.code !== 1) throw new Error(`git merge-tree failed: ${firstLines(merged.stderr)}`)
    // The first line is the tree's id; the conflicting paths follow, once each.
    const files = merged.stdout
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l !== '')
    return { behind, conflicts: [...new Set(files)] }
  }

  /** True when any of `files` differs between the branch and `sha`. */
  async differs(repoPath: string, branch: string, sha: string, files: string[]): Promise<boolean> {
    const diff = await this.git(['diff', '--quiet', `refs/heads/${branch}`, sha, '--', ...files], repoPath)
    return diff.code === 1
  }

  private async resolve(repoPath: string, ref: string): Promise<string | null> {
    const out = await this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoPath)
    return out.code === 0 ? out.stdout.trim() : null
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
