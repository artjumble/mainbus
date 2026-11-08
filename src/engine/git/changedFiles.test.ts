import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { branchChanges, parseNameStatus } from './changedFiles'
import { runGit } from './git'

let tmp: string
let repo: string

async function git(...args: string[]): Promise<string> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], repo)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

async function write(name: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true })
  await fs.writeFile(path.join(repo, name), text)
}

const changes = () => branchChanges(runGit, repo, 'main')

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-changed-'))
  repo = path.join(tmp, 'repo é')
  await fs.mkdir(repo)
  await git('init', '-b', 'main')
  await write('keep.txt', 'keep\n')
  await write('edit.txt', 'one\n')
  await write('gone.txt', 'gone\n')
  await write('old name.txt', 'a long enough body to be detected as a rename\nsecond line\nthird line\n')
  await git('add', '.')
  await git('commit', '-m', 'initial')
  await git('checkout', '-b', 'feature')
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
})

describe('branchChanges', () => {
  it('is empty when nothing has changed', async () => {
    expect(await changes()).toEqual({ base: 'main', files: [] })
  })

  it('lists committed added, modified, deleted and renamed files', async () => {
    await write('new.txt', 'new\n')
    await write('edit.txt', 'two\n')
    await git('rm', 'gone.txt')
    await git('mv', 'old name.txt', 'néw name.txt')
    await git('add', '.')
    await git('commit', '-m', 'work')
    expect((await changes())!.files).toEqual([
      { kind: 'modified', path: 'edit.txt' },
      { kind: 'deleted', path: 'gone.txt' },
      { kind: 'renamed', path: 'néw name.txt', from: 'old name.txt' },
      { kind: 'added', path: 'new.txt' }
    ].sort((a, b) => (a.path < b.path ? -1 : 1)))
  })

  it('lists uncommitted work: modified, untracked, staged rename and deleted', async () => {
    await write('edit.txt', 'two\n')
    await write('docs/untracked.md', 'x\n')
    await git('mv', 'old name.txt', 'moved.txt')
    await fs.rm(path.join(repo, 'gone.txt'))
    const files = (await changes())!.files
    expect(files).toContainEqual({ kind: 'modified', path: 'edit.txt' })
    expect(files).toContainEqual({ kind: 'added', path: 'docs/untracked.md' })
    expect(files).toContainEqual({ kind: 'renamed', path: 'moved.txt', from: 'old name.txt' })
    expect(files).toContainEqual({ kind: 'deleted', path: 'gone.txt' })
    expect(files).toHaveLength(4)
  })

  it('lists a file once when it is committed and edited again', async () => {
    await write('edit.txt', 'two\n')
    await git('commit', '-am', 'one')
    await write('edit.txt', 'three\n')
    expect((await changes())!.files).toEqual([{ kind: 'modified', path: 'edit.txt' }])
  })

  it("doesn't list what only the base gained after branching", async () => {
    await git('checkout', 'main')
    await write('base-only.txt', 'b\n')
    await git('add', '.')
    await git('commit', '-m', 'base moved')
    await git('checkout', 'feature')
    await write('mine.txt', 'm\n')
    expect((await changes())!.files).toEqual([{ kind: 'added', path: 'mine.txt' }])
  })

  it('is null for a base that does not exist', async () => {
    expect(await branchChanges(runGit, repo, 'nope')).toBeNull()
  })
})

describe('parseNameStatus', () => {
  it('reads each kind', () => {
    expect(parseNameStatus('A\0a\0M\0b\0T\0t\0D\0c\0R100\0old\0new\0')).toEqual([
      { kind: 'added', path: 'a' },
      { kind: 'modified', path: 'b' },
      { kind: 'modified', path: 't' },
      { kind: 'deleted', path: 'c' },
      { kind: 'renamed', path: 'new', from: 'old' }
    ])
  })
})
