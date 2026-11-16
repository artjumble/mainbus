import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { baseBranchWarning, checkFolder, NO_IDENTITY_MESSAGE, prepareFolder, previewSetup, WorkspaceNotReadyError } from './folderSetup'
import type { GitRunner } from './git'

vi.setConfig({ testTimeout: 60_000 })

let tmp: string
let folder: string

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
}

/** A git that ignores the machine's configuration; `extra` adds identity or settings. */
function gitWith(extra: Record<string, string> = {}): GitRunner {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('GIT_')) env[k] = v
  }
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: path.join(tmp, 'global.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    // Without a name and email git must not guess them from the host name.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'user.useConfigOnly',
    GIT_CONFIG_VALUE_0: 'true',
    ...extra
  })
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      execFile('git', ['-c', 'core.longpaths=true', ...args], { cwd, env, windowsHide: true }, (error, stdout, stderr) => {
        if (error === null) resolve({ code: 0, stdout, stderr })
        else if (typeof error.code === 'number') resolve({ code: error.code, stdout, stderr })
        else reject(error)
      })
    })
}

async function out(git: GitRunner, args: string[], cwd = folder): Promise<string> {
  const r = await git(args, cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

async function write(rel: string, content = 'x\n'): Promise<void> {
  await fs.mkdir(path.dirname(path.join(folder, rel)), { recursive: true })
  await fs.writeFile(path.join(folder, rel), content)
}

const tracked = async (git: GitRunner): Promise<string[]> =>
  (await out(git, ['ls-tree', '-r', '--name-only', 'HEAD'])).split('\n').filter(Boolean).sort()

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-setup-'))
  await fs.writeFile(path.join(tmp, 'global.gitconfig'), '')
  folder = path.join(tmp, 'folder')
  await fs.mkdir(folder)
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('checkFolder', () => {
  it('reports a plain folder as not_a_repo', async () => {
    expect(await checkFolder(gitWith(), folder)).toEqual({ status: 'not_a_repo', folder, root: folder })
  })

  it('reports a repository without commits, with the root when given a subfolder', async () => {
    const git = gitWith()
    await out(git, ['init', '-b', 'main'])
    await fs.mkdir(path.join(folder, 'sub'))
    const r = await checkFolder(git, path.join(folder, 'sub'))
    expect(r.status).toBe('no_commits')
    expect(await fs.realpath(r.root)).toBe(await fs.realpath(folder))
  })

  it('reports a ready repository, and a detached HEAD', async () => {
    const git = gitWith(IDENTITY)
    await out(git, ['init', '-b', 'main'])
    await write('a.txt')
    await out(git, ['add', '.'])
    await out(git, ['commit', '-m', 'one'])
    expect((await checkFolder(git, folder)).status).toBe('ready')
    await out(git, ['checkout', '--detach'])
    expect((await checkFolder(git, folder)).status).toBe('detached_head')
  })

  it('refuses a missing folder', async () => {
    await expect(checkFolder(gitWith(), path.join(tmp, 'nope'))).rejects.toThrow('Folder does not exist')
  })

  describe('base branch warning', () => {
    const git = (): GitRunner => gitWith(IDENTITY)
    async function repoOn(branch: string): Promise<GitRunner> {
      const g = git()
      await out(g, ['init', '-b', branch])
      await write('a.txt')
      await out(g, ['add', '.'])
      await out(g, ['commit', '-m', 'one'])
      return g
    }
    const warningOf = async (g: GitRunner): Promise<unknown> => (await checkFolder(g, folder)).baseWarning

    it('passes main and master', async () => {
      expect(await warningOf(await repoOn('main'))).toBeUndefined()
      await fs.rm(path.join(folder, '.git'), { recursive: true, force: true })
      expect(await warningOf(await repoOn('master'))).toBeUndefined()
    })

    it('flags a feature branch, without the remote line when there is no remote', async () => {
      expect(await warningOf(await repoOn('fm/feature'))).toEqual({ branch: 'fm/feature', notOnRemote: false, restored: false })
    })

    it("adds the not-on-origin line only when there is a remote without origin/<branch>", async () => {
      const g = await repoOn('fm/feature')
      await out(g, ['remote', 'add', 'origin', path.join(tmp, 'nowhere.git')])
      expect(await warningOf(g)).toEqual({ branch: 'fm/feature', notOnRemote: true, restored: false })
      await out(g, ['update-ref', 'refs/remotes/origin/fm/feature', 'HEAD'])
      expect(await warningOf(g)).toEqual({ branch: 'fm/feature', notOnRemote: false, restored: false })
    })

    it("passes the remote's default branch", async () => {
      const g = await repoOn('develop')
      await out(g, ['remote', 'add', 'origin', path.join(tmp, 'nowhere.git')])
      await out(g, ['update-ref', 'refs/remotes/origin/develop', 'HEAD'])
      await out(g, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop'])
      expect(await warningOf(g)).toBeUndefined()
    })

    it('flags a stored base that is not main, master or the default, and marks it restored', async () => {
      const g = await repoOn('main')
      expect(await baseBranchWarning(g, folder, 'fm/old', true)).toEqual({ branch: 'fm/old', notOnRemote: false, restored: true })
      expect(await baseBranchWarning(g, folder, 'master', true)).toBeNull()
    })
  })
})

describe('previewSetup', () => {
  it('counts the files and top-level entries, flags secrets and generated folders, and leaves the folder alone', async () => {
    await write('README.md', 'hello\n')
    await write('src/a.txt')
    await write('src/b.txt')
    await write('.env', 'SECRET=1\n')
    await write('node_modules/pkg/index.js')
    await write('node_modules/pkg/other.js')
    const before = (await fs.readdir(folder)).sort()
    const p = await previewSetup(gitWith(), folder)
    expect(p.files).toBe(6)
    expect(Object.fromEntries(p.entries.map((e) => [e.name, [e.folder, e.files]]))).toEqual({
      '.env': [false, 1],
      node_modules: [true, 2],
      'README.md': [false, 1],
      src: [true, 2]
    })
    expect(p.warnings.map((w) => [w.kind, w.path, w.files])).toEqual([
      ['secret', '.env', 1],
      ['generated', 'node_modules', 2]
    ])
    expect((await fs.readdir(folder)).sort()).toEqual(before)
  })

  it('flags a file over 50 MB', async () => {
    await write('big.bin', '')
    await fs.truncate(path.join(folder, 'big.bin'), 51 * 1024 * 1024)
    const p = await previewSetup(gitWith(), folder)
    expect(p.warnings).toEqual([{ kind: 'large', path: 'big.bin', files: 1, bytes: 51 * 1024 * 1024 }])
  })

  it('respects .gitignore', async () => {
    await write('.gitignore', 'secret.txt\nlogs/\n')
    await write('secret.txt')
    await write('logs/a.log')
    await write('keep.txt')
    const p = await previewSetup(gitWith(), folder)
    expect(p.entries.map((e) => e.name).sort()).toEqual(['.gitignore', 'keep.txt'])
  })

  it('previews a repository without commits and creates no index', async () => {
    const git = gitWith()
    await out(git, ['init', '-b', 'main'])
    await write('a.txt')
    expect((await previewSetup(git, folder)).files).toBe(1)
    await expect(fs.stat(path.join(folder, '.git', 'index'))).rejects.toThrow()
  })

  it('refuses a ready repository', async () => {
    const git = gitWith(IDENTITY)
    await out(git, ['init', '-b', 'main'])
    await out(git, ['commit', '--allow-empty', '-m', 'one'])
    await expect(previewSetup(git, folder)).rejects.toThrow('Only a folder')
  })
})

describe('prepareFolder', () => {
  it('initialises with main, commits the files, and adds no remote', async () => {
    const git = gitWith(IDENTITY)
    await write('README.md')
    await write('src/a.txt')
    const root = await prepareFolder(git, folder, { commitFiles: true })
    expect(root).toBe(folder)
    expect(await out(git, ['symbolic-ref', '--short', 'HEAD'])).toBe('main')
    expect(await tracked(git)).toEqual(['README.md', 'src/a.txt'])
    expect(await out(git, ['rev-list', '--count', 'HEAD'])).toBe('1')
    expect(await out(git, ['log', '-1', '--format=%s'])).toBe('Initial commit')
    expect(await out(git, ['remote'])).toBe('')
  })

  it("uses the user's init.defaultBranch", async () => {
    const git = gitWith({ ...IDENTITY, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_1: 'init.defaultBranch', GIT_CONFIG_VALUE_1: 'trunk' })
    await prepareFolder(git, folder, { commitFiles: false })
    expect(await out(git, ['symbolic-ref', '--short', 'HEAD'])).toBe('trunk')
  })

  it('makes an empty commit, even with a file already staged', async () => {
    const git = gitWith(IDENTITY)
    await out(git, ['init', '-b', 'main'])
    await write('staged.txt')
    await out(git, ['add', 'staged.txt'])
    await prepareFolder(git, folder, { commitFiles: false })
    expect(await tracked(git)).toEqual([])
    expect(await out(git, ['rev-list', '--count', 'HEAD'])).toBe('1')
  })

  it('respects .gitignore when committing', async () => {
    const git = gitWith(IDENTITY)
    await write('.gitignore', 'ignored.txt\n')
    await write('ignored.txt')
    await write('kept.txt')
    await prepareFolder(git, folder, { commitFiles: true })
    expect(await tracked(git)).toEqual(['.gitignore', 'kept.txt'])
  })

  it('writes the optional .gitignore for the flagged items, keeping the existing one', async () => {
    const git = gitWith(IDENTITY)
    await write('.gitignore', 'ignored.txt')
    await write('.env', 'SECRET=1\n')
    await write('node_modules/p/i.js')
    await write('app.txt')
    await prepareFolder(git, folder, { commitFiles: true, writeGitignore: true })
    const ignore = await fs.readFile(path.join(folder, '.gitignore'), 'utf8')
    expect(ignore).toBe('ignored.txt\n# Added by Mainbus\n/.env\n/node_modules/\n')
    expect(await tracked(git)).toEqual(['.gitignore', 'app.txt'])
  })

  it('ignores the .gitignore choice for an empty commit', async () => {
    const git = gitWith(IDENTITY)
    await write('.env')
    await prepareFolder(git, folder, { commitFiles: false, writeGitignore: true })
    await expect(fs.stat(path.join(folder, '.gitignore'))).rejects.toThrow()
  })

  it('without an identity says so plainly and changes nothing', async () => {
    const git = gitWith()
    await write('a.txt')
    await expect(prepareFolder(git, folder, { commitFiles: true })).rejects.toThrow(NO_IDENTITY_MESSAGE)
    await expect(fs.stat(path.join(folder, '.git'))).rejects.toThrow()
    expect((await git(['config', '--get', 'user.name'], folder)).stdout.trim()).toBe('')
    expect((await git(['config', '--get', 'user.email'], folder)).stdout.trim()).toBe('')
  })

  it('refuses a detached HEAD with the suggestion', async () => {
    const git = gitWith(IDENTITY)
    await out(git, ['init', '-b', 'main'])
    await out(git, ['commit', '--allow-empty', '-m', 'one'])
    await out(git, ['checkout', '--detach'])
    const err = await prepareFolder(git, folder, { commitFiles: true }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkspaceNotReadyError)
    expect((err as WorkspaceNotReadyError).reason).toBe('detached_head')
    expect((err as Error).message).toContain('git switch -c <name>')
  })

  it('leaves a ready repository as it is', async () => {
    const git = gitWith(IDENTITY)
    await out(git, ['init', '-b', 'main'])
    await out(git, ['commit', '--allow-empty', '-m', 'one'])
    await prepareFolder(git, folder, { commitFiles: true })
    expect(await out(git, ['rev-list', '--count', 'HEAD'])).toBe('1')
  })
})
