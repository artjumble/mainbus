import fs from 'node:fs/promises'
import path from 'node:path'
import type { Ticket, Workspace } from '../../shared/domain'
import { scratchPathFor, type HomePaths } from '../home'
import type { PendingCleanupRepo } from '../store/cleanups'
import type { GitRunner } from './git'
import { branchName, slugify } from './slug'

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false
  )
}

/** Canonical form for comparing a path with what `git worktree list` prints (forward slashes, maybe different case). */
async function canonical(p: string): Promise<string> {
  const resolved = await fs.realpath(p).catch(() => path.resolve(p))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Removes a folder and everything in it; the default is fs.rm with a few retries for Windows file locks. */
export type RemoveDir = (dir: string) => Promise<void>

const removeDir: RemoveDir = (dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 })

export class WorktreeManager {
  constructor(
    private readonly git: GitRunner,
    private readonly paths: HomePaths,
    private readonly cleanups: PendingCleanupRepo,
    private readonly warn: (message: string) => void = (m) => console.warn(m),
    private readonly rmDir: RemoveDir = removeDir
  ) {}

  /**
   * Creates the ticket's branch and worktree, or returns the existing ones. Once the ticket has a stored
   * branch and worktree path they are reused, so renaming the ticket never moves its work.
   * The ticket's scratch folder is created too, every time, so one deleted since the last run comes back.
   */
  async ensure(ws: Workspace, t: Ticket): Promise<{ branch: string; path: string; scratch: string }> {
    const branch = t.branch ?? branchName(t.number, t.title)
    const wtPath = t.worktreePath ?? path.join(this.paths.worktrees, ws.slug, `${t.number}-${slugify(t.title)}`)
    const scratch = scratchPathFor(this.paths, wtPath)
    await fs.mkdir(scratch, { recursive: true })

    if (await this.isRegistered(ws.repoPath, wtPath)) {
      if (await exists(wtPath)) return { branch, path: wtPath, scratch }
      // Registered but the folder was deleted behind git's back.
      await this.run(['worktree', 'prune'], ws.repoPath)
    }

    const branchExists = (await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], ws.repoPath)).code === 0
    const addArgs = branchExists
      ? ['worktree', 'add', wtPath, branch]
      : ['worktree', 'add', '-b', branch, wtPath, ws.baseBranch]

    let added = await this.git(addArgs, ws.repoPath)
    if (added.code !== 0) {
      // A stale registration for this path makes add fail; prune and try once more.
      await this.git(['worktree', 'prune'], ws.repoPath)
      added = await this.git(addArgs, ws.repoPath)
    }
    if (added.code !== 0) throw new Error(`git ${addArgs.join(' ')} failed: ${added.stderr.trim()}`)
    return { branch, path: wtPath, scratch }
  }

  /** Untracked files count; the flag keeps a user's status.showUntrackedFiles=no from hiding them. */
  async hasUncommitted(wtPath: string): Promise<boolean> {
    const status = await this.run(['status', '--porcelain', '--untracked-files=normal'], wtPath)
    return status.stdout.trim() !== ''
  }

  /**
   * Removes the worktree folder, then the ticket's scratch folder; the branch is always kept. Without
   * `discard`, a worktree with uncommitted work is left untouched and 'dirty' is returned. A scratch folder
   * that can't be removed is only a warning: it holds nothing the user needs.
   */
  async remove(
    ticketId: string,
    repoPath: string,
    wtPath: string,
    branch: string,
    opts: { discard: boolean }
  ): Promise<'removed' | 'dirty'> {
    const present = await exists(wtPath)
    if (present && !opts.discard && (await this.hasUncommitted(wtPath))) return 'dirty'

    // Record the decision first so an interrupted removal is finished on next launch.
    await this.cleanups.add(ticketId, repoPath, wtPath, branch)
    if (present) {
      const removed = await this.git(
        ['worktree', 'remove', ...(opts.discard ? ['--force'] : []), wtPath],
        repoPath
      )
      if (removed.code !== 0 && (await exists(wtPath))) {
        // Without `discard` the user never agreed to lose files that appeared since the check,
        // so don't leave a row that recovery would force through.
        if (!opts.discard) await this.cleanups.done(ticketId)
        throw new Error(`git worktree remove failed: ${removed.stderr.trim()}`)
      }
    }
    await this.run(['worktree', 'prune'], repoPath)
    await this.removeScratch(wtPath)
    await this.cleanups.done(ticketId)
    return 'removed'
  }

  /** Finishes removals that were recorded but interrupted. Returns the ticket ids it completed. */
  async recoverPendingCleanups(): Promise<string[]> {
    const completed: string[] = []
    for (const row of await this.cleanups.list()) {
      try {
        // The row means removal was already decided, so force.
        if (await exists(row.path)) await this.git(['worktree', 'remove', '--force', row.path], row.repoPath)
        if (await exists(row.path)) continue
        await this.git(['worktree', 'prune'], row.repoPath)
        await this.removeScratch(row.path)
        await this.cleanups.done(row.ticketId)
        completed.push(row.ticketId)
      } catch {
        // Repo gone or git unavailable: keep the row and retry on next launch.
      }
    }
    return completed
  }

  /** Removes the scratch folder of the worktree at `wtPath`. Never throws: a failure is a warning. */
  private async removeScratch(wtPath: string): Promise<void> {
    const scratch = scratchPathFor(this.paths, wtPath)
    try {
      await this.rmDir(scratch)
    } catch (err) {
      this.warn(`Mainbus could not remove the scratch folder ${scratch}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async isRegistered(repoPath: string, wtPath: string): Promise<boolean> {
    const list = await this.run(['worktree', 'list', '--porcelain'], repoPath)
    const target = await canonical(wtPath)
    for (const line of list.stdout.split(/\r?\n/)) {
      if (line.startsWith('worktree ') && (await canonical(line.slice('worktree '.length))) === target) return true
    }
    return false
  }

  /** Runs git and throws on a non-zero exit. */
  private async run(args: string[], cwd: string) {
    const result = await this.git(args, cwd)
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
    return result
  }
}
