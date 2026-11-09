import fs from 'node:fs/promises'
import path from 'node:path'
import type { Workspace } from '../../shared/domain'
import type { GitRunner } from '../git/git'
import { baselineFoldersFor, type BaselineFolders, type HomePaths } from '../home'

/** Git is told to use long paths for the calls that create or delete a worktree, whatever the user's own config says. */
const worktreeArgs = (...args: string[]): string[] => ['-c', 'core.longpaths=true', 'worktree', ...args]

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false
  )
}

async function canonical(p: string): Promise<string> {
  const resolved = await fs.realpath(p).catch(() => path.resolve(p))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export interface BaselineFolder extends BaselineFolders {
  /** True when this call made the worktree (its dependencies aren't installed). */
  created: boolean
}

/**
 * The baseline folder of each workspace: a detached worktree of the newest base, kept outside the ticket folders. It is
 * Mainbus's own, never holds anyone's work, and is moved to a new commit by a forced checkout.
 */
export class BaselineWorktrees {
  constructor(
    private readonly git: GitRunner,
    private readonly paths: HomePaths
  ) {}

  foldersFor(ws: Pick<Workspace, 'slug'>): BaselineFolders {
    return baselineFoldersFor(this.paths, ws.slug)
  }

  /** Makes the worktree if it isn't there, else moves it to `sha` and removes untracked files that aren't ignored (installed dependencies stay). */
  async ensure(ws: Pick<Workspace, 'slug' | 'repoPath'>, sha: string): Promise<BaselineFolder> {
    const f = this.foldersFor(ws)
    await fs.mkdir(f.root, { recursive: true })
    let created = false
    if (!(await this.isRegistered(ws.repoPath, f.repo)) || !(await exists(f.repo))) {
      await this.run(worktreeArgs('prune'), ws.repoPath)
      // A folder git no longer lists is ours to clear: it only ever held a checkout of the base.
      await fs.rm(f.repo, { recursive: true, force: true, maxRetries: 3 })
      const args = worktreeArgs('add', '--detach', f.repo, sha)
      let added = await this.git(args, ws.repoPath)
      if (added.code !== 0) {
        await this.git(worktreeArgs('prune'), ws.repoPath)
        added = await this.git(args, ws.repoPath)
      }
      if (added.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${added.stderr.trim()}`)
      created = true
    } else {
      await this.run(['checkout', '--detach', '--force', sha], f.repo)
      await this.run(['clean', '-fd'], f.repo)
    }
    for (const dir of [f.temp, f.results, f.logs]) await fs.mkdir(dir, { recursive: true })
    return { ...f, created }
  }

  /** Removes the worktree and the workspace's whole baseline folder. Never throws: a leftover is only disk space. */
  async remove(ws: Pick<Workspace, 'slug' | 'repoPath'>): Promise<void> {
    const f = this.foldersFor(ws)
    try {
      if (await this.isRegistered(ws.repoPath, f.repo)) await this.git(worktreeArgs('remove', '--force', f.repo), ws.repoPath)
      await fs.rm(f.root, { recursive: true, force: true, maxRetries: 3 })
      await this.git(worktreeArgs('prune'), ws.repoPath)
    } catch {
      // Repo gone or git unavailable.
    }
  }

  private async isRegistered(repoPath: string, wtPath: string): Promise<boolean> {
    const list = await this.git(['worktree', 'list', '--porcelain'], repoPath)
    if (list.code !== 0) return false
    const target = await canonical(wtPath)
    for (const line of list.stdout.split(/\r?\n/)) {
      if (line.startsWith('worktree ') && (await canonical(line.slice('worktree '.length))) === target) return true
    }
    return false
  }

  private async run(args: string[], cwd: string): Promise<void> {
    const result = await this.git(args, cwd)
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  }
}
