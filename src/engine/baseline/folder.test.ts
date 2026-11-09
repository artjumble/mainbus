import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runGit } from '../git/git'
import { resolveHome, type HomePaths } from '../home'
import { BaselineWorktrees } from './folder'

let tmp: string
let repoPath: string
let paths: HomePaths
let folders: BaselineWorktrees
const ws = { slug: 'my-repo', repoPath: '' }

async function git(args: string[], cwd = repoPath): Promise<string> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

async function commit(file: string, text: string): Promise<string> {
  await fs.writeFile(path.join(repoPath, file), text)
  await git(['add', '.'])
  await git(['commit', '-m', `change ${file}`])
  return git(['rev-parse', 'HEAD'])
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-baseline-'))
  repoPath = path.join(tmp, 'repo')
  await fs.mkdir(repoPath)
  await git(['init', '-b', 'main'])
  await fs.writeFile(path.join(repoPath, '.gitignore'), 'node_modules\n')
  await commit('a.txt', 'one\n')
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  folders = new BaselineWorktrees(runGit, paths)
  ws.repoPath = repoPath
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
})

describe('BaselineWorktrees', () => {
  it('creates a detached worktree of the commit, outside the ticket folders, with folders for the run', async () => {
    const sha = await git(['rev-parse', 'HEAD'])
    const f = await folders.ensure(ws, sha)

    expect(f.created).toBe(true)
    expect(f.repo.startsWith(paths.baselines)).toBe(true)
    expect(f.repo.startsWith(paths.worktrees)).toBe(false)
    expect(await fs.readFile(path.join(f.repo, 'a.txt'), 'utf8')).toBe('one\n')
    expect(await git(['rev-parse', 'HEAD'], f.repo)).toBe(sha)
    expect(await git(['symbolic-ref', '-q', 'HEAD'], f.repo).catch(() => 'detached')).toBe('detached')
    for (const dir of [f.temp, f.results, f.logs]) expect((await fs.stat(dir)).isDirectory()).toBe(true)
  })

  it('moves the same worktree to a new commit, removes stray files, and keeps ignored ones such as node_modules', async () => {
    const first = await git(['rev-parse', 'HEAD'])
    const f = await folders.ensure(ws, first)
    await fs.mkdir(path.join(f.repo, 'node_modules'))
    await fs.writeFile(path.join(f.repo, 'node_modules', 'dep.js'), 'x')
    await fs.writeFile(path.join(f.repo, 'stray.txt'), 'left by a test')
    await fs.writeFile(path.join(f.repo, 'a.txt'), 'edited by a test\n')

    const second = await commit('b.txt', 'two\n')
    const again = await folders.ensure(ws, second)

    expect(again.created).toBe(false)
    expect(again.repo).toBe(f.repo)
    expect(await git(['rev-parse', 'HEAD'], f.repo)).toBe(second)
    expect(await fs.readFile(path.join(f.repo, 'a.txt'), 'utf8')).toBe('one\n')
    expect(await fs.readFile(path.join(f.repo, 'b.txt'), 'utf8')).toBe('two\n')
    await expect(fs.access(path.join(f.repo, 'stray.txt'))).rejects.toThrow()
    await expect(fs.access(path.join(f.repo, 'node_modules', 'dep.js'))).resolves.toBeUndefined()
  })

  it('makes the worktree again when its folder was deleted behind git', async () => {
    const sha = await git(['rev-parse', 'HEAD'])
    const f = await folders.ensure(ws, sha)
    await fs.rm(f.repo, { recursive: true, force: true })
    const again = await folders.ensure(ws, sha)
    expect(again.created).toBe(true)
    expect(await fs.readFile(path.join(again.repo, 'a.txt'), 'utf8')).toBe('one\n')
  })

  it('removes the worktree and the workspace folder, leaving only the repository itself registered', async () => {
    const f = await folders.ensure(ws, await git(['rev-parse', 'HEAD']))
    await folders.remove(ws)

    await expect(fs.access(f.root)).rejects.toThrow()
    expect((await git(['worktree', 'list', '--porcelain'])).match(/^worktree /gm)).toHaveLength(1)
    // Removing again is harmless.
    await folders.remove(ws)
  })
})
