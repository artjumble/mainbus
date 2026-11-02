import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  ws = { id: 'ws-1', name: 'My repo', repoPath, baseBranch: 'main', slug: 'my-repo', openPrOnReview: false }
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

  it('ensure is idempotent', async () => {
    const first = await manager.ensure(ws, ticket)
    await fs.writeFile(path.join(first.path, 'work.txt'), 'in progress\n')

    const second = await manager.ensure(ws, ticket)

    expect(second).toEqual(first)
    expect(await exists(path.join(first.path, 'work.txt'))).toBe(true)
  })

  it('re-attaches the existing branch when the worktree folder is gone', async () => {
    const first = await manager.ensure(ws, ticket)
    await git(['-C', first.path, '-c', 'user.name=T', '-c', 'user.email=t@e.com', 'commit', '--allow-empty', '-m', 'work'])
    await fs.rm(first.path, { recursive: true, force: true, maxRetries: 5 })

    const again = await manager.ensure(ws, ticket)

    expect(again).toEqual(first)
    expect(await git(['log', '--format=%s', '-1'], again.path)).toContain('work')
  })

  it('a renamed ticket keeps its stored branch and worktree', async () => {
    const first = await manager.ensure(ws, ticket)
    await fs.writeFile(path.join(first.path, 'work.txt'), 'in progress\n')
    const renamed = { ...ticket, title: 'Throttle sign-in', branch: first.branch, worktreePath: first.path }

    expect(await manager.ensure(ws, renamed)).toEqual(first)
    expect(await exists(path.join(first.path, 'work.txt'))).toBe(true)

    // The folder went away: the stored branch is re-attached at the stored path, not a new one from the title.
    await fs.rm(first.path, { recursive: true, force: true, maxRetries: 5 })
    expect(await manager.ensure(ws, renamed)).toEqual(first)
    expect(await git(['branch', '--list', 'mainbus/14-throttle-sign-in'])).toBe('')
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

      expect(await manager.ensure(ws, { ...ticket, branch: first.branch, worktreePath: first.path })).toEqual(first)
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
      args[0] === 'worktree' && args[1] === 'remove'
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
})
