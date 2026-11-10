import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Ticket } from '../../shared/domain'
import type { MergeMethod, MergePlan } from '../../shared/merge'
import { runCommand, type CommandRunner } from './command'
import { FakeGh } from './fakeGh'
import { BranchMerger, repoOfUrl } from './merge'

let tmp: string
let repo: string
let calls: { file: string; args: string[] }[]
let gh: FakeGh
let merger: BranchMerger

/** Runs a real git command in a throwaway repository (not through the merger's recorded runner). */
async function git(args: string[], cwd = repo): Promise<string> {
  const r = await runCommand('git', args, { cwd, timeoutMs: 30_000 })
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

async function commit(file: string, content: string, message = `change ${file}`, cwd = repo): Promise<void> {
  await fs.writeFile(path.join(cwd, file), content)
  await git(['add', '-A'], cwd)
  await git(['commit', '-m', message], cwd)
}

const ticket = (over: Partial<Pick<Ticket, 'pr'>> = {}): Pick<Ticket, 'number' | 'title' | 'branch' | 'pr'> => ({
  number: 7,
  title: 'Add login',
  branch: 'feat',
  pr: null,
  ...over
})

const ws = (mergeMethod: MergeMethod = 'merge') => ({ repoPath: repo, baseBranch: 'main', mergeMethod })

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-merge-'))
  repo = path.join(tmp, 'repo')
  await fs.mkdir(repo)
  await git(['init', '-b', 'main'])
  await git(['config', 'user.name', 'Test'])
  await git(['config', 'user.email', 'test@example.com'])
  await commit('a.txt', 'a\n')
  calls = []
  gh = new FakeGh()
  const recording: CommandRunner = (file, args, opts) => {
    calls.push({ file, args })
    return runCommand(file, args, opts)
  }
  merger = new BranchMerger(gh.runner(recording), 30_000)
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
})

/** The ticket's branch, one commit ahead of main. */
async function featureBranch(file = 'login.txt'): Promise<void> {
  await git(['checkout', '-q', '-b', 'feat'])
  await commit(file, 'login\n')
  await git(['checkout', '-q', 'main'])
}

const planOf = async (t = ticket(), w = ws()): Promise<MergePlan> => {
  const p = await merger.preview(w, t)
  if (!p.ok) throw new Error(`refused: ${p.reason}`)
  return p.plan
}

const refusalOf = async (t = ticket(), w = ws()) => {
  const p = await merger.preview(w, t)
  if (p.ok) throw new Error('expected a refusal')
  return p
}

describe('a local merge into the checked-out base', () => {
  it('fast-forwards a clean checkout on the base, with git merge --ff-only', async () => {
    await featureBranch()
    const plan = await planOf()
    expect(plan).toMatchObject({ kind: 'local', how: 'fast_forward', commits: 1, checkout: repo, base: 'main', branch: 'feat' })

    const commitAfter = await merger.merge(ws(), plan, { deleteBranch: false })

    expect(commitAfter).toBe(await git(['rev-parse', 'feat']))
    expect(await git(['rev-parse', 'main'])).toBe(commitAfter)
    await expect(fs.readFile(path.join(repo, 'login.txt'), 'utf8')).resolves.toBe('login\n')
    expect(await git(['status', '--porcelain'])).toBe('')
    expect(calls.some((c) => c.args[0] === 'merge' && c.args.includes('--ff-only'))).toBe(true)
  })

  it('makes a merge commit with the ticket number and title when it cannot fast-forward and nothing conflicts', async () => {
    await featureBranch()
    await commit('other.txt', 'other\n', 'main moves on')
    const plan = await planOf()
    expect(plan).toMatchObject({ how: 'merge_commit', message: 'Merge #7: Add login' })

    const after = await merger.merge(ws(), plan, { deleteBranch: false })

    expect(await git(['log', '-1', '--format=%s', 'main'])).toBe('Merge #7: Add login')
    expect((await git(['rev-list', '--parents', '-n', '1', 'main'])).split(' ')).toHaveLength(3)
    expect(after).toBe(await git(['rev-parse', 'main']))
    await expect(fs.access(path.join(repo, 'login.txt'))).resolves.toBeUndefined()
    expect(calls.some((c) => c.args[0] === 'merge' && c.args.includes('--no-ff'))).toBe(true)
  })

  it.each([
    ['a modified file', async () => fs.writeFile(path.join(repo, 'a.txt'), 'edited\n'), 'a.txt'],
    ['an untracked file', async () => fs.writeFile(path.join(repo, 'new.txt'), 'x\n'), 'new.txt'],
    [
      'a staged file',
      async () => {
        await fs.writeFile(path.join(repo, 'staged.txt'), 'x\n')
        await git(['add', 'staged.txt'])
      },
      'staged.txt'
    ]
  ])('is refused when the checkout has %s, naming it and suggesting to commit or stash', async (_name, dirty, file) => {
    await featureBranch()
    await dirty()
    const refusal = await refusalOf()
    expect(refusal.reason).toContain('uncommitted changes')
    expect(refusal.reason).toContain(file)
    expect(refusal.suggest).toBe('commit_or_stash')
    expect(await git(['rev-parse', 'main'])).not.toBe(await git(['rev-parse', 'feat']))
  })

  it('is refused when merging would conflict, listing the files and suggesting Update from main', async () => {
    await git(['checkout', '-q', '-b', 'feat'])
    await commit('a.txt', 'feature\n')
    await git(['checkout', '-q', 'main'])
    await commit('a.txt', 'main\n')
    const refusal = await refusalOf()
    expect(refusal.reason).toMatch(/would conflict in a\.txt/)
    expect(refusal.suggest).toBe('update_from_main')
    expect(await git(['status', '--porcelain'])).toBe('')
  })

  it('is refused when the branch has nothing the base lacks', async () => {
    await git(['branch', 'feat'])
    expect((await refusalOf()).reason).toMatch(/nothing main doesn't have/)
  })

  it('is refused when main is checked out in another folder, not the user\'s checkout', async () => {
    await featureBranch()
    await git(['checkout', '-q', '-b', 'elsewhere'])
    const other = path.join(tmp, 'other-tree')
    await git(['worktree', 'add', '-q', other, 'main'])
    const refusal = await refusalOf()
    expect(refusal.reason).toMatch(/main is checked out in .*other-tree, not in your checkout/)
  })
})

describe('a local merge when the base is not checked out', () => {
  it('fast-forwards only the branch ref and leaves the checkout\'s files alone', async () => {
    await featureBranch()
    await git(['checkout', '-q', '-b', 'mine'])
    await fs.writeFile(path.join(repo, 'wip.txt'), 'work in progress\n')
    const plan = await planOf()
    expect(plan).toMatchObject({ how: 'fast_forward_ref', checkout: null, currentBranch: 'mine' })

    const after = await merger.merge(ws(), plan, { deleteBranch: false })

    expect(await git(['rev-parse', 'main'])).toBe(after)
    expect(after).toBe(await git(['rev-parse', 'feat']))
    expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('mine')
    expect(await git(['status', '--porcelain'])).toBe('?? wip.txt')
    await expect(fs.access(path.join(repo, 'login.txt'))).rejects.toThrow()
  })

  it('is refused when main has moved on and the branch cannot fast-forward', async () => {
    await featureBranch()
    await git(['checkout', '-q', 'main'])
    await commit('other.txt', 'other\n')
    await git(['checkout', '-q', '-b', 'mine'])
    const refusal = await refusalOf()
    expect(refusal.reason).toMatch(/can't fast-forward/)
    expect(refusal.suggest).toBe('update_from_main')
  })

  it('git itself refuses a non fast-forward if main moved after the plan was made', async () => {
    await featureBranch()
    await git(['checkout', '-q', '-b', 'mine'])
    const plan = await planOf()
    await git(['checkout', '-q', 'main'])
    await commit('other.txt', 'other\n')
    await git(['checkout', '-q', 'mine'])
    await expect(merger.merge(ws(), plan, { deleteBranch: false })).rejects.toThrow(/could not fast-forward main/)
    expect(await git(['log', '-1', '--format=%s', 'main'])).toBe('change other.txt')
  })
})

describe('a pull request', () => {
  const pr = { url: 'https://github.com/example/repo/pull/3', number: 3 }

  beforeEach(async () => {
    await featureBranch()
    await git(['remote', 'add', 'origin', path.join(tmp, 'origin.git')])
    gh.prs.push({ ...pr, base: 'main', head: 'feat', title: 'Add login', body: '', draft: false, state: 'OPEN' })
  })

  it.each<[MergeMethod, string]>([
    ['merge', '--merge'],
    ['squash', '--squash'],
    ['rebase', '--rebase']
  ])('merges with gh pr merge %s, pinned to the repo and the branch head, and touches no local branch', async (method, flag) => {
    const plan = await planOf(ticket({ pr }), ws(method))
    expect(plan).toMatchObject({ kind: 'pull_request', method, head: await git(['rev-parse', 'feat']) })
    const mainBefore = await git(['rev-parse', 'main'])

    const commitAfter = await merger.merge(ws(method), plan, { deleteBranch: false })

    expect(commitAfter).toBeNull()
    const merge = gh.calls.find((c) => c[1] === 'merge')!
    expect(merge).toEqual(['pr', 'merge', '3', flag, '--repo=github.com/example/repo', `--match-head-commit=${await git(['rev-parse', 'feat'])}`])
    expect(gh.prs[0]!.state).toBe('MERGED')
    expect(await git(['rev-parse', 'main'])).toBe(mainBefore)
    expect(await git(['status', '--porcelain'])).toBe('')
  })

  it('adds --delete-branch only when asked', async () => {
    const plan = await planOf(ticket({ pr }))
    await merger.merge(ws(), plan, { deleteBranch: true })
    expect(gh.calls.find((c) => c[1] === 'merge')).toContain('--delete-branch')
  })

  it('reports GitHub\'s refusal plainly', async () => {
    gh.mergeRefusal = 'Pull request #3 is not mergeable: required status checks have not passed'
    const plan = await planOf(ticket({ pr }))
    await expect(merger.merge(ws(), plan, { deleteBranch: false })).rejects.toThrow(
      'GitHub refused the merge: Pull request #3 is not mergeable: required status checks have not passed'
    )
    expect(gh.prs[0]!.state).toBe('OPEN')
  })

  it('does not call it merged when GitHub only queued it', async () => {
    gh.mergeQueued = true
    const plan = await planOf(ticket({ pr }))
    await expect(merger.merge(ws(), plan, { deleteBranch: false })).rejects.toThrow(/hasn't merged pull request #3 yet/)
  })

  it('merges the branch locally when the repository has no remote', async () => {
    await git(['remote', 'remove', 'origin'])
    expect(await planOf(ticket({ pr }))).toMatchObject({ kind: 'local', how: 'fast_forward' })
  })
})

describe('what it never does', () => {
  const FORBIDDEN = ['push', 'reset', 'rebase', 'stash', 'clean', 'checkout', '--force', '-f', '--force-with-lease']

  it('runs no push, reset, rebase, stash, force or + refspec in any case', async () => {
    // fast-forward
    await featureBranch()
    await merger.merge(ws(), await planOf(), { deleteBranch: false })
    // merge commit
    await git(['checkout', '-q', '-b', 'feat2', 'main~1'])
    await commit('two.txt', '2\n')
    await git(['checkout', '-q', 'main'])
    await merger.merge(ws(), await planOf({ ...ticket(), branch: 'feat2' }), { deleteBranch: false })
    // ref fast-forward and the refusals
    await git(['checkout', '-q', '-b', 'feat3', 'main'])
    await commit('three.txt', '3\n')
    await git(['checkout', '-q', '-b', 'mine'])
    await merger.merge(ws(), await planOf({ ...ticket(), branch: 'feat3' }), { deleteBranch: false })
    await fs.writeFile(path.join(repo, 'dirty.txt'), 'x\n')
    await merger.preview(ws(), { ...ticket(), branch: 'feat2' })

    const gitCalls = calls.filter((c) => c.file === 'git')
    expect(gitCalls.length).toBeGreaterThan(5)
    for (const c of calls) {
      expect(c.args.filter((a) => FORBIDDEN.includes(a))).toEqual([])
      expect(c.args.filter((a) => a.startsWith('+') || a.includes(':+'))).toEqual([])
    }
  })

  it('refuses a branch named like an option', async () => {
    const refusal = await refusalOf({ ...ticket(), branch: '--upload-pack=x' })
    expect(refusal.reason).toMatch(/not one Mainbus can merge/)
    expect(calls).toEqual([])
  })
})

describe('repoOfUrl', () => {
  it('gives host/owner/repo for gh --repo', () => {
    expect(repoOfUrl('https://github.com/o/r/pull/9')).toBe('github.com/o/r')
    expect(repoOfUrl('https://ghe.example.com/o/r/pull/9')).toBe('ghe.example.com/o/r')
    expect(repoOfUrl('http://github.com/o/r/pull/9')).toBeNull()
    expect(repoOfUrl('not a url')).toBeNull()
  })
})
