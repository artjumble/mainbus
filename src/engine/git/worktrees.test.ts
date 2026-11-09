import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ticket, Workspace } from '../../shared/domain'
import { resolveHome, type HomePaths } from '../home'
import { createCleanupRepo, type PendingCleanupRepo } from '../store/cleanups'
import { FIXED_NOW, openTestDb } from '../store/testDb'
import { runGit, type GitRunner } from './git'
import { WorktreeManager } from './worktrees'

let tmp: string
let repoPath: string
let paths: HomePaths
let cleanups: PendingCleanupRepo
let closeDb: () => void
let manager: WorktreeManager
let ws: Workspace
const ticket = { id: 'ticket-14', number: 14, title: 'Rate-limit login' } as Ticket

async function git(args: string[], cwd = repoPath): Promise<string> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false
  )
}

/** True for `git [-c ...] worktree <verb>`. */
function isWorktreeCall(args: string[], verb: string): boolean {
  const i = args.indexOf('worktree')
  return i >= 0 && args[i + 1] === verb
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-wt-'))
  repoPath = path.join(tmp, 'my repo é')
  await fs.mkdir(repoPath)
  await git(['init', '-b', 'main'])
  await fs.writeFile(path.join(repoPath, 'README.md'), 'hello\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'initial'])

  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  const testDb = await openTestDb()
  closeDb = testDb.cleanup
  cleanups = createCleanupRepo(testDb.db, () => FIXED_NOW)
  manager = new WorktreeManager(runGit, paths, cleanups)
  ws = { id: 'ws-1', name: 'My repo', repoPath, baseBranch: 'main', slug: 'my-repo', openPrOnReview: false, saveReports: true, reportsFolder: 'docs/investigations', setupCommand: '', setupTimeoutMinutes: 15, testCommands: [] }
})

afterEach(async () => {
  closeDb()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
})

describe('WorktreeManager', () => {
  it('creates branch and worktree under the data home for a repo path with spaces and non-ASCII', async () => {
    const result = await manager.ensure(ws, ticket)

    expect(result.branch).toBe('mainbus/14-rate-limit-login')
    expect(result.path).toBe(path.join(paths.worktrees, 'my-repo', '14-rate-limit-login'))
    expect(await exists(path.join(result.path, 'README.md'))).toBe(true)
    expect(await git(['branch', '--list', result.branch])).toContain(result.branch)
  })

  it('starts a new branch from the ref the resolver names, and returns its notice', async () => {
    await fs.writeFile(path.join(repoPath, 'newer.txt'), 'x\n')
    await git(['switch', '-q', '-c', 'newest'])
    await git(['add', '.'])
    await git(['commit', '-m', 'newer'])
    await git(['switch', '-q', 'main'])
    const baseFor = vi.fn(async () => ({ ref: 'newest', notice: 'from the local one' }))
    const m = new WorktreeManager(runGit, paths, cleanups, undefined, undefined, baseFor)

    const result = await m.ensure(ws, ticket)

    expect(result.baseNotice).toBe('from the local one')
    expect(await exists(path.join(result.path, 'newer.txt'))).toBe(true)
    expect(await git(['rev-parse', 'refs/heads/main'])).not.toBe(await git(['rev-parse', 'refs/heads/' + result.branch]))
    expect(await git(['config', '--get', 'branch.' + result.branch + '.merge']).catch(() => '')).toBe('')
    // An existing branch, or a second call, never asks again.
    await m.ensure(ws, ticket)
    expect(baseFor).toHaveBeenCalledTimes(1)
    expect((await m.ensure(ws, ticket)).baseNotice).toBeNull()
  })

  it('ensure is idempotent', async () => {
    const first = await manager.ensure(ws, ticket)
    await fs.writeFile(path.join(first.path, 'work.txt'), 'in progress\n')

    const second = await manager.ensure(ws, ticket)

    expect(first.created).toBe(true)
    expect(second).toEqual({ ...first, created: false })
    expect(await exists(path.join(first.path, 'work.txt'))).toBe(true)
  })

  it('re-attaches the existing branch when the worktree folder is gone', async () => {
    const first = await manager.ensure(ws, ticket)
    await git(['-C', first.path, '-c', 'user.name=T', '-c', 'user.email=t@e.com', 'commit', '--allow-empty', '-m', 'work'])
    await fs.rm(first.path, { recursive: true, force: true, maxRetries: 5 })

    const again = await manager.ensure(ws, ticket)

    expect(again).toEqual({ ...first, created: true })
    expect(await git(['log', '--format=%s', '-1'], again.path)).toContain('work')
  })

  it('a renamed ticket keeps its stored branch and worktree', async () => {
    const first = await manager.ensure(ws, ticket)
    await fs.writeFile(path.join(first.path, 'work.txt'), 'in progress\n')
    const renamed = { ...ticket, title: 'Throttle sign-in', branch: first.branch, worktreePath: first.path }

    expect(await manager.ensure(ws, renamed)).toEqual({ ...first, created: false })
    expect(await exists(path.join(first.path, 'work.txt'))).toBe(true)

    // The folder went away: the stored branch is re-attached at the stored path, not a new one from the title.
    await fs.rm(first.path, { recursive: true, force: true, maxRetries: 5 })
    expect(await manager.ensure(ws, renamed)).toEqual({ ...first, created: true })
    expect(await git(['branch', '--list', 'mainbus/14-throttle-sign-in'])).toBe('')
  })

  it('gives a long title a short folder and the full branch, and keeps a stored path', async () => {
    const long = { id: 'ticket-88', number: 88, title: 'Tidy leftover npm mentions after the switch to pnpm' } as Ticket
    const made = await manager.ensure(ws, long)

    expect(made.path).toBe(path.join(paths.worktrees, 'my-repo', '88-tidy-leftover'))
    expect(made.branch).toBe('mainbus/88-tidy-leftover-npm-mentions-after-the-swi')

    const old = path.join(paths.worktrees, 'my-repo', '88-tidy-leftover-npm-mentions-after-the-swi')
    await git(['worktree', 'move', made.path, old])
    const stored = { ...long, branch: made.branch, worktreePath: old }
    expect((await manager.ensure(ws, stored)).path).toBe(old)
  })

  it('passes core.longpaths=true to every worktree add, remove and prune', async () => {
    const calls: string[][] = []
    const recording: GitRunner = (args, cwd) => {
      calls.push(args)
      return runGit(args, cwd)
    }
    const m = new WorktreeManager(recording, paths, cleanups)
    const { path: wt, branch } = await m.ensure(ws, ticket)
    await m.remove(ticket.id, repoPath, wt, branch, { discard: false })
    await m.ensure(ws, ticket)
    await cleanups.add(ticket.id, repoPath, wt, branch)
    await m.recoverPendingCleanups()

    const mutating = calls.filter((a) => ['add', 'remove', 'prune'].some((v) => isWorktreeCall(a, v)))
    expect(mutating.length).toBeGreaterThanOrEqual(5)
    for (const a of mutating) expect(a.slice(0, 2)).toEqual(['-c', 'core.longpaths=true'])
  })

  it('adds a worktree for a branch that exists without one', async () => {
    await git(['branch', 'mainbus/14-rate-limit-login', 'main'])

    const result = await manager.ensure(ws, ticket)

    expect(await exists(path.join(result.path, 'README.md'))).toBe(true)
  })

  it('refuses to remove a dirty worktree', async () => {
    const { path: wt, branch } = await manager.ensure(ws, ticket)
    await fs.writeFile(path.join(wt, 'untracked.txt'), 'x')

    expect(await manager.hasUncommitted(wt)).toBe(true)
    const outcome = await manager.remove(ticket.id, repoPath, wt, branch, { discard: false })

    expect(outcome).toBe('dirty')
    expect(await exists(wt)).toBe(true)
    expect(await cleanups.list()).toEqual([])
  })

  it('removes a clean worktree and keeps the branch', async () => {
    const { path: wt, branch } = await manager.ensure(ws, ticket)
    expect(await manager.hasUncommitted(wt)).toBe(false)

    const outcome = await manager.remove(ticket.id, repoPath, wt, branch, { discard: false })

    expect(outcome).toBe('removed')
    expect(await exists(wt)).toBe(false)
    expect(await git(['branch', '--list', branch])).toContain(branch)
    expect(await cleanups.list()).toEqual([])
  })

  it('discards a dirty worktree when asked, still keeping the branch', async () => {
    const { path: wt, branch } = await manager.ensure(ws, ticket)
    await fs.writeFile(path.join(wt, 'untracked.txt'), 'x')

    const outcome = await manager.remove(ticket.id, repoPath, wt, branch, { discard: true })

    expect(outcome).toBe('removed')
    expect(await exists(wt)).toBe(false)
    expect(await git(['branch', '--list', branch])).toContain(branch)
  })

  it('recovers an interrupted removal', async () => {
    const { path: wt, branch } = await manager.ensure(ws, ticket)
    await fs.writeFile(path.join(wt, 'half-done.txt'), 'x')
    await cleanups.add(ticket.id, repoPath, wt, branch)

    const completed = await manager.recoverPendingCleanups()

    expect(completed).toEqual([ticket.id])
    expect(await exists(wt)).toBe(false)
    expect(await cleanups.list()).toEqual([])
    expect(await git(['worktree', 'list', '--porcelain'])).not.toContain('14-rate-limit-login')
    expect(await git(['branch', '--list', branch])).toContain(branch)
  })

  it('recovers a removal whose folder is already gone', async () => {
    const { path: wt, branch } = await manager.ensure(ws, ticket)
    await fs.rm(wt, { recursive: true, force: true, maxRetries: 5 })
    await cleanups.add(ticket.id, repoPath, wt, branch)

    expect(await manager.recoverPendingCleanups()).toEqual([ticket.id])
    expect(await git(['worktree', 'list', '--porcelain'])).not.toContain('14-rate-limit-login')
    expect(await cleanups.list()).toEqual([])
  })

  describe('the scratch folder', () => {
    it('is created beside the worktree, under the data home, on ensure', async () => {
      const result = await manager.ensure(ws, ticket)

      expect(result.scratch).toBe(path.join(paths.scratch, 'my-repo', '14-rate-limit-login'))
      expect(await exists(result.scratch)).toBe(true)
      expect(path.relative(result.path, result.scratch).startsWith('..')).toBe(true)
    })

    it('comes back on a later ensure when it was deleted', async () => {
      const first = await manager.ensure(ws, ticket)
      await fs.rm(first.scratch, { recursive: true, force: true })

      expect(await manager.ensure(ws, { ...ticket, branch: first.branch, worktreePath: first.path })).toEqual({ ...first, created: false })
      expect(await exists(first.scratch)).toBe(true)
    })

    it('is removed with the worktree, files and all', async () => {
      const { path: wt, branch, scratch } = await manager.ensure(ws, ticket)
      await fs.writeFile(path.join(scratch, 'out.txt'), 'x')

      expect(await manager.remove(ticket.id, repoPath, wt, branch, { discard: false })).toBe('removed')
      expect(await exists(scratch)).toBe(false)
    })

    it('stays while the worktree is dirty', async () => {
      const { path: wt, branch, scratch } = await manager.ensure(ws, ticket)
      await fs.writeFile(path.join(wt, 'untracked.txt'), 'x')

      expect(await manager.remove(ticket.id, repoPath, wt, branch, { discard: false })).toBe('dirty')
      expect(await exists(scratch)).toBe(true)
    })

    it('is removed when an interrupted removal is recovered', async () => {
      const { path: wt, branch, scratch } = await manager.ensure(ws, ticket)
      await cleanups.add(ticket.id, repoPath, wt, branch)

      expect(await manager.recoverPendingCleanups()).toEqual([ticket.id])
      expect(await exists(wt)).toBe(false)
      expect(await exists(scratch)).toBe(false)
    })

    it('that cannot be removed is a warning and never keeps the worktree removal from finishing', async () => {
      const { path: wt, branch, scratch } = await manager.ensure(ws, ticket)
      const warnings: string[] = []
      const failRm = async () => {
        throw new Error('EBUSY: resource busy or locked')
      }
      const failing = new WorktreeManager(runGit, paths, cleanups, (m) => warnings.push(m), failRm)

      expect(await failing.remove(ticket.id, repoPath, wt, branch, { discard: false })).toBe('removed')
      expect(await exists(wt)).toBe(false)
      expect(await cleanups.list()).toEqual([])
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(scratch)
      expect(warnings[0]).toContain('EBUSY')

      // The same in recovery: the row is finished all the same.
      await cleanups.add(ticket.id, repoPath, wt, branch)
      expect(await failing.recoverPendingCleanups()).toEqual([ticket.id])
      expect(await cleanups.list()).toEqual([])
      expect(warnings).toHaveLength(2)
    })
  })

  it('sees untracked files even when git is configured to hide them', async () => {
    const { path: wt, branch } = await manager.ensure(ws, ticket)
    await git(['config', 'status.showUntrackedFiles', 'no'])
    await fs.writeFile(path.join(wt, 'untracked.txt'), 'x')

    expect(await manager.hasUncommitted(wt)).toBe(true)
    expect(await manager.remove(ticket.id, repoPath, wt, branch, { discard: false })).toBe('dirty')
    expect(await exists(wt)).toBe(true)
  })

  describe('a worktree git already removed', () => {
    /** Git forgets the worktree; the folder is recreated at the same path, as a half-done removal leaves it. */
    async function unregister(wt: string) {
      await git(['worktree', 'remove', '--force', wt])
      await fs.mkdir(wt)
    }

    it('has its empty folder deleted and the removal finishes', async () => {
      const { path: wt, branch, scratch } = await manager.ensure(ws, ticket)
      await unregister(wt)

      expect(await manager.remove(ticket.id, repoPath, wt, branch, { discard: false })).toBe('removed')
      expect(await exists(wt)).toBe(false)
      expect(await exists(scratch)).toBe(false)
      expect(await cleanups.list()).toEqual([])
      expect(await git(['branch', '--list', branch])).toContain(branch)
    })

    it('keeps a folder that still holds files, and says so', async () => {
      const { path: wt, branch } = await manager.ensure(ws, ticket)
      await unregister(wt)
      await fs.writeFile(path.join(wt, 'keep.txt'), 'x')

      await expect(manager.remove(ticket.id, repoPath, wt, branch, { discard: true })).rejects.toThrow(
        /no longer a git worktree/
      )
      expect(await exists(path.join(wt, 'keep.txt'))).toBe(true)
      expect(await cleanups.list()).toEqual([])
    })

    it('is finished by startup recovery when only the empty folder is left', async () => {
      const { path: wt, branch } = await manager.ensure(ws, ticket)
      await unregister(wt)
      await cleanups.add(ticket.id, repoPath, wt, branch)

      expect(await manager.recoverPendingCleanups()).toEqual([ticket.id])
      expect(await exists(wt)).toBe(false)
      expect(await cleanups.list()).toEqual([])
    })
  })

  it.runIf(process.platform === 'win32')('says a program holds the folder open, and succeeds once it is closed', async () => {
    const { path: wt, branch } = await manager.ensure(ws, ticket)
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: wt, stdio: 'ignore' })
    try {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })

      await expect(manager.remove(ticket.id, repoPath, wt, branch, { discard: false })).rejects.toThrow(
        /a program still has it open/
      )
    } finally {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill()
      await exited
    }

    expect(await manager.remove(ticket.id, repoPath, wt, branch, { discard: false })).toBe('removed')
    expect(await exists(wt)).toBe(false)
  })

  describe('when git fails mid-removal', () => {
    const failRemove: GitRunner = async (args, cwd) =>
      isWorktreeCall(args, 'remove')
        ? { code: 1, stdout: '', stderr: 'simulated failure' }
        : runGit(args, cwd)

    it('keeps the folder and clears the row when work appears after the dirty check', async () => {
      const { path: wt, branch } = await manager.ensure(ws, ticket)
      const raceWriter: GitRunner = async (args, cwd) => {
        const result = await runGit(args, cwd)
        // The status check saw a clean tree; now the agent writes a file before removal runs.
        if (args[0] === 'status') await fs.writeFile(path.join(wt, 'late.txt'), 'x')
        return result
      }
      const racing = new WorktreeManager(raceWriter, paths, cleanups)

      await expect(racing.remove(ticket.id, repoPath, wt, branch, { discard: false })).rejects.toThrow(
        /worktree remove failed/
      )

      expect(await exists(path.join(wt, 'late.txt'))).toBe(true)
      expect(await cleanups.list()).toEqual([])
    })

    it('keeps the row for recovery when a discard removal fails', async () => {
      const { path: wt, branch } = await manager.ensure(ws, ticket)
      const failing = new WorktreeManager(failRemove, paths, cleanups)

      await expect(failing.remove(ticket.id, repoPath, wt, branch, { discard: true })).rejects.toThrow(
        /worktree remove failed/
      )

      expect(await exists(wt)).toBe(true)
      expect((await cleanups.list()).map((c) => c.ticketId)).toEqual([ticket.id])
    })

    it('leaves the row and reports nothing when recovery cannot remove the folder, then finishes next time', async () => {
      const { path: wt, branch } = await manager.ensure(ws, ticket)
      await cleanups.add(ticket.id, repoPath, wt, branch)
      const failing = new WorktreeManager(failRemove, paths, cleanups)

      expect(await failing.recoverPendingCleanups()).toEqual([])
      expect(await exists(wt)).toBe(true)
      expect((await cleanups.list()).map((c) => c.ticketId)).toEqual([ticket.id])

      expect(await manager.recoverPendingCleanups()).toEqual([ticket.id])
      expect(await exists(wt)).toBe(false)
      expect(await cleanups.list()).toEqual([])
    })
  })

  describe('a removal git leaves half done', () => {
    /** Git unregisters the worktree, then fails to delete the files (as with paths over 260 characters on Windows). */
    function halfDone(wt: string): GitRunner {
      return async (args, cwd) => {
        if (!isWorktreeCall(args, 'remove')) return runGit(args, cwd)
        await runGit(['worktree', 'remove', '--force', wt], cwd)
        await fs.mkdir(path.join(wt, 'node_modules', 'pkg'), { recursive: true })
        await fs.writeFile(path.join(wt, 'node_modules', 'pkg', 'index.js'), 'x')
        return { code: 1, stdout: '', stderr: 'error: failed to delete: Filename too long' }
      }
    }

    it('is finished by Mainbus, with the row kept until the folder is gone', async () => {
      const { path: wt, branch, scratch } = await manager.ensure(ws, ticket)
      const rowsAtDelete: number[] = []
      const rm = new WorktreeManager(halfDone(wt), paths, cleanups, undefined, async (dir) => {
        rowsAtDelete.push((await cleanups.list()).length)
        await fs.rm(dir, { recursive: true, force: true })
      })

      expect(await rm.remove(ticket.id, repoPath, wt, branch, { discard: false })).toBe('removed')
      expect(await exists(wt)).toBe(false)
      expect(await exists(scratch)).toBe(false)
      expect(rowsAtDelete[0]).toBe(1)
      expect(await cleanups.list()).toEqual([])
    })

    it('survives a crash in the middle: the row stays and the next launch finishes', async () => {
      const { path: wt, branch, scratch } = await manager.ensure(ws, ticket)
      const crashing = new WorktreeManager(halfDone(wt), paths, cleanups, undefined, () => Promise.reject(new Error('simulated crash')))

      await expect(crashing.remove(ticket.id, repoPath, wt, branch, { discard: false })).rejects.toThrow(/simulated crash/)
      expect(await exists(wt)).toBe(true)
      expect((await cleanups.list()).map((c) => c.ticketId)).toEqual([ticket.id])

      expect(await manager.recoverPendingCleanups()).toEqual([ticket.id])
      expect(await exists(wt)).toBe(false)
      expect(await exists(scratch)).toBe(false)
      expect(await cleanups.list()).toEqual([])
    })

    it('says a program holds it open on a lock error, keeps the row, and finishes on the next try', async () => {
      const { path: wt, branch } = await manager.ensure(ws, ticket)
      const locked = new WorktreeManager(halfDone(wt), paths, cleanups, undefined, () =>
        Promise.reject(Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' }))
      )

      const failure = locked.remove(ticket.id, repoPath, wt, branch, { discard: false })
      await expect(failure).rejects.toThrow(/a program still has it open/)
      await expect(failure).rejects.toThrow(/already removed the folder's contents/)
      expect((await cleanups.list()).map((c) => c.ticketId)).toEqual([ticket.id])

      expect(await manager.remove(ticket.id, repoPath, wt, branch, { discard: false })).toBe('removed')
      expect(await exists(wt)).toBe(false)
      expect(await cleanups.list()).toEqual([])
    })
  })

  describe("a ticket's own folder that git no longer lists", () => {
    const slugOf = () => ws.slug
    async function leftover() {
      const made = await manager.ensure(ws, ticket)
      await git(['worktree', 'remove', '--force', made.path])
      await fs.mkdir(path.join(made.path, 'node_modules', 'a'), { recursive: true })
      await fs.writeFile(path.join(made.path, 'node_modules', 'a', 'one.js'), 'x')
      await fs.writeFile(path.join(made.path, 'node_modules', 'a', 'two.js'), 'x')
      await fs.writeFile(path.join(made.path, 'package.json'), '{}')
      return made
    }

    it('is reported, not touched, when the caller can ask', async () => {
      const { path: wt, branch } = await leftover()

      const outcome = await manager.remove(ticket.id, repoPath, wt, branch, { discard: false, leftover: { workspaceSlug: slugOf(), delete: false } })

      expect(outcome).toBe('leftover')
      expect(await exists(path.join(wt, 'package.json'))).toBe(true)
      expect(await cleanups.list()).toEqual([])
    })

    it('is described with counts, the biggest entry first, and whether the branch is kept', async () => {
      const { path: wt, branch } = await leftover()

      expect(await manager.describeLeftover(repoPath, wt, branch)).toEqual({
        files: 3,
        entries: [
          { name: 'node_modules', files: 2 },
          { name: 'package.json', files: 1 }
        ],
        commits: 'kept'
      })
      await git(['branch', '-D', branch])
      expect((await manager.describeLeftover(repoPath, wt, branch)).commits).toBe('unknown')
    })

    it('is deleted when the user chose Delete, and a link inside it leaves its target alone', async () => {
      const { path: wt, branch, scratch } = await leftover()
      const target = path.join(tmp, 'link-target')
      await fs.mkdir(target)
      await fs.writeFile(path.join(target, 'precious.txt'), 'x')
      await fs.symlink(target, path.join(wt, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

      const outcome = await manager.remove(ticket.id, repoPath, wt, branch, { discard: false, leftover: { workspaceSlug: slugOf(), delete: true } })

      expect(outcome).toBe('removed')
      expect(await exists(wt)).toBe(false)
      expect(await exists(scratch)).toBe(false)
      expect(await exists(path.join(target, 'precious.txt'))).toBe(true)
      expect(await cleanups.list()).toEqual([])
    })

    it('is still refused when the folder belongs to another workspace, is outside the work folder, or is a link', async () => {
      const { path: wt, branch } = await leftover()
      const ask = { discard: false, leftover: { workspaceSlug: slugOf(), delete: true } }

      const other = path.join(paths.worktrees, 'other-ws', path.basename(wt))
      await fs.mkdir(path.dirname(other), { recursive: true })
      await fs.rename(wt, other)
      await expect(manager.remove(ticket.id, repoPath, other, branch, ask)).rejects.toThrow(/no longer a git worktree/)

      const outside = path.join(tmp, 'elsewhere')
      await fs.rename(other, outside)
      await expect(manager.remove(ticket.id, repoPath, outside, branch, ask)).rejects.toThrow(/no longer a git worktree/)

      await fs.mkdir(path.dirname(wt), { recursive: true })
      await fs.symlink(outside, wt, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(manager.remove(ticket.id, repoPath, wt, branch, ask)).rejects.toThrow(/no longer a git worktree/)
      expect(await exists(path.join(outside, 'package.json'))).toBe(true)
      expect(await cleanups.list()).toEqual([])
    })
  })

  it.runIf(process.platform === 'win32')('removes a worktree holding paths over 260 characters', async () => {
    await fs.writeFile(path.join(repoPath, '.gitignore'), 'node_modules/\n')
    await git(['add', '.'])
    await git(['commit', '-m', 'ignore'])
    const { path: wt, branch } = await manager.ensure(ws, ticket)
    const deep = path.join(wt, 'node_modules', '.pnpm', 'a'.repeat(100) + '@1.0.0', 'node_modules', 'a'.repeat(100), 'dist')
    await fs.mkdir(deep, { recursive: true })
    await fs.writeFile(path.join(deep, 'index.js'), 'x')
    expect(path.join(deep, 'index.js').length).toBeGreaterThan(260)

    // Git itself is made to fail, as it does for a user whose config turns long paths off.
    const noLongPaths: GitRunner = (args, cwd) => runGit(args.map((a) => (a === 'core.longpaths=true' ? 'core.longpaths=false' : a)), cwd)
    const m = new WorktreeManager(noLongPaths, paths, cleanups)
    expect(await m.remove(ticket.id, repoPath, wt, branch, { discard: false })).toBe('removed')
    expect(await exists(wt)).toBe(false)
  })
})
