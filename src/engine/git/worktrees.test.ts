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
  ws = { id: 'ws-1', name: 'My repo', repoPath, baseBranch: 'main', slug: 'my-repo' }
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

  it('sees untracked files even when git is configured to hide them', async () => {
    const { path: wt, branch } = await manager.ensure(ws, ticket)
    await git(['config', 'status.showUntrackedFiles', 'no'])
    await fs.writeFile(path.join(wt, 'untracked.txt'), 'x')

    expect(await manager.hasUncommitted(wt)).toBe(true)
    expect(await manager.remove(ticket.id, repoPath, wt, branch, { discard: false })).toBe('dirty')
    expect(await exists(wt)).toBe(true)
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
