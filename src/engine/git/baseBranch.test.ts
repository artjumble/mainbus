import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { branchExists, currentBranch, defaultBranch, hasOrigin, listBranches } from './baseBranch'
import { runGit } from './git'

let tmp: string
let repo: string

async function git(args: string[], cwd = repo): Promise<void> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}

async function makeRepo(initial: string): Promise<void> {
  await fs.mkdir(repo)
  await git(['init', '-b', initial])
  await fs.writeFile(path.join(repo, 'a.txt'), 'a\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'initial'])
}

async function addOrigin(): Promise<void> {
  const origin = path.join(tmp, 'origin.git')
  await git(['init', '--bare', origin], tmp)
  await git(['remote', 'add', 'origin', origin])
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-basebranch-'))
  repo = path.join(tmp, 'repo')
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('defaultBranch', () => {
  it('prefers origin/HEAD over main', async () => {
    await makeRepo('main')
    await git(['branch', 'trunk'])
    await addOrigin()
    await git(['push', 'origin', 'main', 'trunk'])
    await git(['remote', 'set-head', 'origin', 'trunk'])
    expect(await defaultBranch(runGit, repo)).toBe('trunk')
  })

  it('falls back to main, then master, then null', async () => {
    await makeRepo('master')
    await git(['checkout', '-b', 'work'])
    expect(await defaultBranch(runGit, repo)).toBe('master')
    await git(['branch', 'main'])
    expect(await defaultBranch(runGit, repo)).toBe('main')
    await git(['branch', '-D', 'main', 'master'])
    expect(await defaultBranch(runGit, repo)).toBeNull()
    expect(await currentBranch(runGit, repo)).toBe('work')
  })
})

describe('listBranches and hasOrigin', () => {
  it('lists local branches and marks the ones origin has', async () => {
    await makeRepo('main')
    await git(['branch', 'local-only'])
    expect(await hasOrigin(runGit, repo)).toBe(false)
    await addOrigin()
    await git(['push', '-u', 'origin', 'main'])
    expect(await hasOrigin(runGit, repo)).toBe(true)
    expect(await listBranches(runGit, repo)).toEqual([
      { name: 'local-only', onRemote: false },
      { name: 'main', onRemote: true }
    ])
  })

  it('knows which branches exist locally, refusing odd names', async () => {
    await makeRepo('main')
    expect(await branchExists(runGit, repo, 'main')).toBe(true)
    expect(await branchExists(runGit, repo, 'nope')).toBe(false)
    expect(await branchExists(runGit, repo, '--all')).toBe(false)
  })
})
