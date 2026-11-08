import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCommand, type CommandRunner } from './command'
import { BranchFreshnessChecker } from './freshness'
import { runGit } from './git'

let tmp: string
let repo: string
let origin: string
let checker: BranchFreshnessChecker

async function git(args: string[], cwd = repo): Promise<string> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

async function commit(file: string, content: string, cwd = repo): Promise<void> {
  await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true })
  await fs.writeFile(path.join(cwd, file), content)
  await git(['add', '.'], cwd)
  await git(['commit', '-m', `change ${file}`], cwd)
}

const ws = () => ({ repoPath: repo, baseBranch: 'main' })

/** Makes origin's main move ahead without touching `repo`: another clone pushes. */
async function pushFromElsewhere(file: string, content: string): Promise<void> {
  const other = path.join(tmp, 'other')
  await git(['clone', '-q', origin, other], tmp)
  await commit(file, content, other)
  await git(['push', '-q', 'origin', 'main'], other)
  await fs.rm(other, { recursive: true, force: true, maxRetries: 5 })
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-fresh-'))
  repo = path.join(tmp, 'repo')
  origin = path.join(tmp, 'origin.git')
  await fs.mkdir(repo)
  await git(['init', '-b', 'main'])
  await commit('README.md', 'hello\n')
  await git(['init', '--bare', '-b', 'main', origin], tmp)
  await git(['remote', 'add', 'origin', origin])
  await git(['push', '-q', '-u', 'origin', 'main'])
  checker = new BranchFreshnessChecker(runGit, runCommand)
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
})

describe('newestBase', () => {
  it('is origin/main when it is ahead of the local main, without touching the checkout or the local branch', async () => {
    await pushFromElsewhere('merged.txt', 'from github\n')
    const localBefore = await git(['rev-parse', 'refs/heads/main'])
    await fs.writeFile(path.join(repo, 'wip.txt'), 'uncommitted\n')

    const base = await checker.newestBase(ws(), { fetch: true })

    expect(base.ref).toBe('origin/main')
    expect(base.sha).toBe(await git(['rev-parse', 'refs/remotes/origin/main']))
    expect(base.sha).not.toBe(localBefore)
    expect(base.notice).toBeNull()
    expect(await git(['rev-parse', 'refs/heads/main'])).toBe(localBefore)
    expect(await git(['rev-parse', 'HEAD'])).toBe(localBefore)
    expect(await git(['status', '--porcelain'])).toBe('?? wip.txt')
    await expect(fs.access(path.join(repo, 'merged.txt'))).rejects.toThrow()
  })

  it('is the local main when origin is not ahead, with no notice', async () => {
    const base = await checker.newestBase(ws(), { fetch: true })
    expect(base.ref).toBe('main')
    expect(base.notice).toBeNull()
  })

  it('is the local main when the two have diverged', async () => {
    await pushFromElsewhere('theirs.txt', 'x\n')
    await commit('mine.txt', 'y\n')
    const base = await checker.newestBase(ws(), { fetch: true })
    expect(base.ref).toBe('main')
    expect(base.notice).toBeNull()
  })

  it('falls back to the local main with a notice when there is no remote', async () => {
    await git(['remote', 'remove', 'origin'])
    const base = await checker.newestBase(ws(), { fetch: true })
    expect(base).toMatchObject({ ref: 'main', fetchError: 'the repository has no origin remote' })
    expect(base.notice).toBe("This branch starts from your local main: the repository has no origin remote, so Mainbus couldn't fetch a newer one.")
  })

  it('falls back with a notice when the fetch fails', async () => {
    await git(['remote', 'set-url', 'origin', path.join(tmp, 'missing.git')])
    const base = await checker.newestBase(ws(), { fetch: true })
    expect(base.ref).toBe('main')
    expect(base.notice).toMatch(/^This branch starts from your local main: git fetch failed: .*so Mainbus couldn't fetch a newer one\.$/)
  })

  it('does not fetch, and gives no notice, when asked not to', async () => {
    const run = vi.fn<CommandRunner>()
    const base = await new BranchFreshnessChecker(runGit, run).newestBase(ws(), { fetch: false })
    expect(run).not.toHaveBeenCalled()
    expect(base).toMatchObject({ ref: 'main', notice: null, fetchError: null })
  })
})

describe('fetchBase', () => {
  it('fetches only the base into origin/<base>, with no prompts', async () => {
    const run = vi.fn<CommandRunner>(async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }))
    const result = await new BranchFreshnessChecker(runGit, run).fetchBase(ws())
    expect(result).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith('git', ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'], {
      cwd: repo,
      env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0' }),
      timeoutMs: expect.any(Number)
    })
  })

  it('reports a timeout, and strips credentials from an error', async () => {
    const slow: CommandRunner = async () => ({ code: -1, stdout: '', stderr: '', timedOut: true })
    expect(await new BranchFreshnessChecker(runGit, slow, 5000).fetchBase(ws())).toEqual({ ok: false, reason: 'git fetch timed out after 5 seconds' })
    const denied: CommandRunner = async () => ({
      code: 128,
      stdout: '',
      stderr: 'fatal: unable to access https://user:secret@example.com/r.git/: 403',
      timedOut: false
    })
    const result = await new BranchFreshnessChecker(runGit, denied).fetchBase(ws())
    expect(result).toMatchObject({ ok: false })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('refuses a base branch that starts with a dash', async () => {
    const result = await checker.fetchBase({ repoPath: repo, baseBranch: '--upload-pack=x' })
    expect(result.ok).toBe(false)
  })

  it('runs fetches of one repository one at a time', async () => {
    let running = 0
    let overlapped = false
    const run: CommandRunner = async () => {
      overlapped ||= ++running > 1
      await new Promise((r) => setTimeout(r, 20))
      running--
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    const c = new BranchFreshnessChecker(runGit, run)
    await Promise.all([c.fetchBase(ws()), c.fetchBase(ws()), c.fetchBase(ws())])
    expect(overlapped).toBe(false)
  })
})

describe('check', () => {
  async function branch(name: string): Promise<void> {
    await git(['branch', name, 'main'])
  }

  it('counts the commits of the base the branch lacks', async () => {
    await branch('feature')
    await commit('a.txt', '1\n')
    await commit('b.txt', '2\n')
    expect(await checker.check(repo, 'feature', await git(['rev-parse', 'main']))).toEqual({ behind: 2, conflicts: [] })
  })

  it('is 0 behind for a branch that has the base, even with commits of its own', async () => {
    await branch('feature')
    await git(['checkout', '-q', 'feature'])
    await commit('own.txt', 'x\n')
    await git(['checkout', '-q', 'main'])
    expect(await checker.check(repo, 'feature', await git(['rev-parse', 'main']))).toEqual({ behind: 0, conflicts: [] })
  })

  it('lists the conflicting files, and changes no working tree', async () => {
    await commit('migrations/journal.txt', '0001\n')
    await branch('feature')
    await git(['checkout', '-q', 'feature'])
    await commit('migrations/journal.txt', '0001\n0002_b\n')
    await commit('migrations/0002_b.sql', 'b\n')
    await git(['checkout', '-q', 'main'])
    await commit('migrations/journal.txt', '0001\n0002_a\n')
    await commit('other.txt', 'fine\n')
    const before = await git(['status', '--porcelain'])

    const result = await checker.check(repo, 'feature', await git(['rev-parse', 'main']))

    expect(result).toEqual({ behind: 2, conflicts: ['migrations/journal.txt'] })
    expect(await git(['status', '--porcelain'])).toBe(before)
    expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
  })

  it('has no conflicts when the branches touch different files', async () => {
    await branch('feature')
    await git(['checkout', '-q', 'feature'])
    await commit('own.txt', 'x\n')
    await git(['checkout', '-q', 'main'])
    await commit('theirs.txt', 'y\n')
    expect(await checker.check(repo, 'feature', await git(['rev-parse', 'main']))).toEqual({ behind: 1, conflicts: [] })
  })

  it('throws for a branch that does not exist', async () => {
    await expect(checker.check(repo, 'nope', await git(['rev-parse', 'main']))).rejects.toThrow()
  })
})

describe('differs', () => {
  it('is true only when one of the files differs between the branch and the base', async () => {
    await commit('package-lock.json', '{}\n')
    await git(['branch', 'feature', 'main'])
    const before = await git(['rev-parse', 'main'])
    expect(await checker.differs(repo, 'feature', before, ['package-lock.json', 'yarn.lock'])).toBe(false)
    await commit('package-lock.json', '{"a":1}\n')
    expect(await checker.differs(repo, 'feature', await git(['rev-parse', 'main']), ['package-lock.json', 'yarn.lock'])).toBe(true)
    await commit('other.txt', 'x\n')
    expect(await checker.differs(repo, 'feature', await git(['rev-parse', 'main']), ['yarn.lock'])).toBe(false)
  })
})
