import fs from 'node:fs/promises'
import path from 'node:path'
import type { Ticket, Workspace } from '../../shared/domain'
import { scratchPathFor, ticketFoldersFor, type HomePaths } from '../home'
import type { PendingCleanupRepo } from '../store/cleanups'
import { branchChanges, type BranchChanges } from './changedFiles'
import type { GitRunner } from './git'
import { branchName, folderName } from './slug'

/** The files under a folder, counting anything that isn't a folder as one. Links are counted, never followed. */
async function countFiles(dir: string): Promise<number> {
  let n = 0
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    n += e.isDirectory() ? await countFiles(path.join(dir, e.name)) : 1
  }
  return n
}

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

/** What an unregistered folder holds, for asking the user before it is deleted. */
export interface LeftoverFolder {
  files: number
  /** The top-level entries with the files under each (a file counts as one), most files first. */
  entries: { name: string; files: number }[]
  /** 'kept' when the ticket's branch still exists: commits made in a worktree live in the repository, not the folder. */
  commits: 'kept' | 'unknown'
}

/** Git is told to use long paths for the calls that create or delete a worktree, whatever the user's own config says. */
const worktreeArgs = (...args: string[]): string[] => ['-c', 'core.longpaths=true', 'worktree', ...args]

/** The ref a new ticket branch starts from, with a notice for the thread when it is the local base for want of a newer one. */
export type BaseResolver = (ws: Workspace) => Promise<{ ref: string; notice: string | null }>

const NOT_A_WORKTREE = (dir: string) =>
  `${dir} is no longer a git worktree but still holds files, so Mainbus left it alone. It needs looking at: check what is in it, then delete it or move the files out.`

const HELD_OPEN = (contentsRemoved: boolean) =>
  "Windows wouldn't delete the ticket's folder because a program still has it open: a terminal, an editor, or a process an agent left running. Close it, then try Move to Done again. " +
  (contentsRemoved
    ? "Git had already removed the folder's contents, so trying again will finish it."
    : 'Git had not removed the folder yet.')

/** True for the failures Windows gives when a program has the folder open. */
function isLockError(err: unknown): boolean {
  const text = err instanceof Error ? `${(err as NodeJS.ErrnoException).code ?? ''} ${err.message}` : String(err)
  return /permission denied|being used by another process|in use|EBUSY|EPERM|EACCES/i.test(text)
}

export class WorktreeManager {
  constructor(
    private readonly git: GitRunner,
    private readonly paths: HomePaths,
    private readonly cleanups: PendingCleanupRepo,
    private readonly warn: (message: string) => void = (m) => console.warn(m),
    private readonly rmDir: RemoveDir = removeDir,
    /** What a new branch starts from, and what to tell the user if that isn't the newest base. By default the local base. */
    private readonly baseFor: BaseResolver = (ws) => Promise.resolve({ ref: ws.baseBranch, notice: null })
  ) {}

  /**
   * Creates the ticket's branch and worktree, or returns the existing ones. Once the ticket has a stored
   * branch and worktree path they are reused, so renaming the ticket never moves its work.
   * `created` is true only when this call made the folder, which is when the workspace's setup command is due.
   * The ticket's scratch folder is created too, every time, so one deleted since the last run comes back.
   */
  async ensure(ws: Workspace, t: Ticket): Promise<{ branch: string; path: string; scratch: string; created: boolean; baseNotice: string | null }> {
    const branch = t.branch ?? branchName(t.number, t.title)
    const wtPath = t.worktreePath ?? path.join(ticketFoldersFor(this.paths, ws.slug), folderName(t.number, t.title))
    const scratch = scratchPathFor(this.paths, wtPath)
    await fs.mkdir(scratch, { recursive: true })

    if (await this.isRegistered(ws.repoPath, wtPath)) {
      if (await exists(wtPath)) return { branch, path: wtPath, scratch, created: false, baseNotice: null }
      // Registered but the folder was deleted behind git's back.
      await this.run(worktreeArgs('prune'), ws.repoPath)
    }

    const branchExists = (await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], ws.repoPath)).code === 0
    // Only a branch made now needs a base; an existing one keeps the commits it has.
    const base = branchExists ? null : await this.baseFor(ws)
    const addArgs =
      base === null ? worktreeArgs('add', wtPath, branch) : worktreeArgs('add', '--no-track', '-b', branch, wtPath, base.ref)

    let added = await this.git(addArgs, ws.repoPath)
    if (added.code !== 0) {
      // A stale registration for this path makes add fail; prune and try once more.
      await this.git(worktreeArgs('prune'), ws.repoPath)
      added = await this.git(addArgs, ws.repoPath)
    }
    if (added.code !== 0) throw new Error(`git ${addArgs.join(' ')} failed: ${added.stderr.trim()}`)
    return { branch, path: wtPath, scratch, created: true, baseNotice: base?.notice ?? null }
  }

  /**
   * Brings back the folder of a ticket whose folder is missing: the same path, checked out on the ticket's existing
   * branch. It never creates a branch or uses another path; it throws when the branch is gone.
   */
  async recreate(ws: Workspace, t: Ticket): Promise<void> {
    if (t.branch === null || t.worktreePath === null) throw new Error('The ticket has no folder to recreate')
    const found = await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}`], ws.repoPath)
    if (found.code !== 0) throw new Error(`The branch ${t.branch} no longer exists, so the folder can't be recreated`)
    await this.run(worktreeArgs('prune'), ws.repoPath)
    await this.run(worktreeArgs('add', t.worktreePath, t.branch), ws.repoPath)
    await fs.mkdir(scratchPathFor(this.paths, t.worktreePath), { recursive: true })
  }

  /** The files the branch changes against `baseRef`, committed or not; null when that can't be worked out. */
  changedFiles(wtPath: string, baseRef: string): Promise<BranchChanges | null> {
    return branchChanges(this.git, wtPath, baseRef)
  }

  /** Untracked files count; the flag keeps a user's status.showUntrackedFiles=no from hiding them. */
  async hasUncommitted(wtPath: string): Promise<boolean> {
    const status = await this.run(['status', '--porcelain', '--untracked-files=normal'], wtPath)
    return status.stdout.trim() !== ''
  }

  /** True when the folder is a worktree of the repo with uncommitted work; false for a missing or unregistered folder. */
  async isDirty(repoPath: string, wtPath: string): Promise<boolean> {
    return (await exists(wtPath)) && (await this.isRegistered(repoPath, wtPath)) && (await this.hasUncommitted(wtPath))
  }

  /**
   * Removes the worktree folder, then the ticket's scratch folder; the branch is always kept. Without
   * `discard`, a worktree with uncommitted work is left untouched and 'dirty' is returned. A scratch folder
   * that can't be removed is only a warning: it holds nothing the user needs.
   *
   * A folder git no longer lists but that still holds files is refused, unless a pending removal for this ticket
   * covers it, or `leftover` is given and the folder is the ticket's own: then 'leftover' is returned (ask the user),
   * or with `leftover.delete` the folder is deleted.
   */
  async remove(
    ticketId: string,
    repoPath: string,
    wtPath: string,
    branch: string,
    opts: { discard: boolean; leftover?: { workspaceSlug: string; delete: boolean } }
  ): Promise<'removed' | 'dirty' | 'leftover'> {
    const present = await exists(wtPath)
    // A folder git no longer lists is what a half-done removal leaves behind. Don't ask git about it:
    // `git status` there would answer for whatever repository contains the folder.
    const registered = present && (await this.isRegistered(repoPath, wtPath))
    const hasFiles = present && !registered && !(await this.isEmptyDir(wtPath))
    if (hasFiles && !(await this.isPending(ticketId, wtPath))) {
      // Mainbus can't vouch for what is in it.
      if (!opts.leftover || !(await this.isOwnFolder(wtPath, opts.leftover.workspaceSlug))) throw new Error(NOT_A_WORKTREE(wtPath))
      if (!opts.leftover.delete) return 'leftover'
    }
    if (registered && !opts.discard && (await this.hasUncommitted(wtPath))) return 'dirty'

    // Record the decision first so an interrupted removal is finished on next launch.
    await this.cleanups.add(ticketId, repoPath, wtPath, branch)
    if (hasFiles) {
      await this.deleteFolder(wtPath)
    } else if (present && !registered) {
      try {
        await fs.rmdir(wtPath)
      } catch (err) {
        // Gone after all is fine; otherwise it is still there and the row would only force it through later.
        if (await exists(wtPath)) {
          if (!opts.discard) await this.cleanups.done(ticketId)
          throw isLockError(err) ? new Error(HELD_OPEN(true)) : err
        }
      }
    } else if (present) {
      const removed = await this.git(worktreeArgs('remove', ...(opts.discard ? ['--force'] : []), wtPath), repoPath)
      if (removed.code !== 0 && (await exists(wtPath))) {
        if (await this.isRegistered(repoPath, wtPath)) {
          // Git stopped before touching the worktree. Without `discard` the user never agreed to lose files
          // that appeared since the check, so don't leave a row that recovery would force through.
          if (!opts.discard) await this.cleanups.done(ticketId)
          const detail = removed.stderr.trim()
          if (isLockError(detail)) throw new Error(HELD_OPEN(false))
          throw new Error(`git worktree remove failed: ${detail}`)
        }
        // Git drops the worktree from its list even when deleting the folder fails (a path over 260 characters, a
        // lock), and our own uncommitted check passed. Finish the job; the row stays until the folder is gone.
        await this.deleteFolder(wtPath)
      }
    }
    await this.run(worktreeArgs('prune'), repoPath)
    await this.removeScratch(wtPath)
    await this.cleanups.done(ticketId)
    return 'removed'
  }

  /** What is in the folder at `wtPath`, which git no longer lists, and whether the branch still has the ticket's commits. */
  async describeLeftover(repoPath: string, wtPath: string, branch: string): Promise<LeftoverFolder> {
    const entries: { name: string; files: number }[] = []
    for (const e of await fs.readdir(wtPath, { withFileTypes: true })) {
      entries.push({ name: e.name, files: e.isDirectory() ? await countFiles(path.join(wtPath, e.name)) : 1 })
    }
    entries.sort((x, y) => y.files - x.files || x.name.localeCompare(y.name))
    const found = await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoPath)
    return { files: entries.reduce((n, e) => n + e.files, 0), entries, commits: found.code === 0 ? 'kept' : 'unknown' }
  }

  /** Deletes a folder git no longer lists. A lock gives the held-open message; the pending row stays either way. */
  private async deleteFolder(dir: string): Promise<void> {
    try {
      await this.rmDir(dir)
    } catch (err) {
      if (!(await exists(dir))) return
      throw isLockError(err) ? new Error(HELD_OPEN(true)) : err
    }
    if (await exists(dir)) throw new Error(`Mainbus could not delete ${dir}`)
  }

  /** True when a recorded removal for this ticket covers the path: the removal was already decided. */
  private async isPending(ticketId: string, wtPath: string): Promise<boolean> {
    const target = await canonical(wtPath)
    for (const row of await this.cleanups.list()) {
      if (row.ticketId === ticketId && (await canonical(row.path)) === target) return true
    }
    return false
  }

  /** True when `wtPath` is a real folder (not a link) directly inside the workspace's folder for ticket worktrees. */
  private async isOwnFolder(wtPath: string, workspaceSlug: string): Promise<boolean> {
    if (path.basename(wtPath) === '') return false
    const stat = await fs.lstat(wtPath).catch(() => null)
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return false
    return (await canonical(path.dirname(wtPath))) === (await canonical(ticketFoldersFor(this.paths, workspaceSlug)))
  }

  /** Finishes removals that were recorded but interrupted. Returns the ticket ids it completed. */
  async recoverPendingCleanups(): Promise<string[]> {
    const completed: string[] = []
    for (const row of await this.cleanups.list()) {
      try {
        // The row means removal was already decided, so force.
        if (await exists(row.path)) {
          if (await this.isRegistered(row.repoPath, row.path)) {
            await this.git(worktreeArgs('remove', '--force', row.path), row.repoPath)
          }
          if ((await exists(row.path)) && !(await this.isRegistered(row.repoPath, row.path))) {
            await this.rmDir(row.path)
          }
        }
        if (await exists(row.path)) continue
        await this.git(worktreeArgs('prune'), row.repoPath)
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

  private async isEmptyDir(dir: string): Promise<boolean> {
    return (await fs.readdir(dir).catch(() => ['?'])).length === 0
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
