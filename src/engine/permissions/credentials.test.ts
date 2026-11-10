// .npmrc, .yarnrc and .yarnrc.yml are credentials only when they hold auth-like settings. The tests use real files in
// throwaway folders under the system temp folder (the ticket's scratch folder when an agent runs them).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { credentialReason, isCredentialPath } from './credentials'
import { guardReason } from './guard'

let root: string
let worktree: string
let elsewhere: string

const write = (dir: string, name: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
  fs.writeFileSync(path.join(dir, name), text)
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cred-'))
  worktree = path.join(root, 'wt')
  elsewhere = path.join(root, 'other')
  fs.mkdirSync(worktree)
  fs.mkdirSync(elsewhere)
  write(worktree, '.npmrc', 'virtual-store-dir-max-length=60\n')
  write(worktree, 'tokened/.npmrc', '//registry.npmjs.org/:_authToken=abc\n')
  write(worktree, 'auth/.npmrc', '_auth=abc\n')
  write(worktree, 'pw/.npmrc', 'password=abc\n')
  write(worktree, 'user/.npmrc', 'username=me\n')
  write(worktree, 'commented/.npmrc', '# project settings\nregistry=https://x.example/\n')
  write(worktree, '.yarnrc', 'save-prefix ""\n')
  write(worktree, 'y/.yarnrc.yml', 'nodeLinker: node-modules\n')
  write(worktree, 'ytoken/.yarnrc.yml', 'npmAuthToken: abc\n')
  write(worktree, 'big/.npmrc', `${'a=1\n'.repeat(40000)}`)
  write(worktree, 'src/deep/keep.txt', 'x')
  write(worktree, 'src/.npmrc', 'registry=https://x.example/\n')
  write(elsewhere, '.npmrc', 'virtual-store-dir-max-length=60\n')
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const files = (cwd?: string) => ({ worktree, ...(cwd ? { cwd } : {}) })
const cat = (p: string, cwd?: string): string | null => credentialReason('Bash', { command: `cat ${p}` }, files(cwd))

describe('.npmrc, .yarnrc and .yarnrc.yml', () => {
  test('without auth-like settings they are not credentials', () => {
    expect(cat('.npmrc')).toBeNull()
    expect(cat('.yarnrc')).toBeNull()
    expect(cat('y/.yarnrc.yml')).toBeNull()
    expect(cat('commented/.npmrc')).toBeNull()
    expect(cat(`${worktree}/.npmrc`)).toBeNull()
    expect(cat('./.npmrc')).toBeNull()
    expect(cat('src/deep/../../.npmrc')).toBeNull()
    expect(credentialReason('Read', { file_path: path.join(worktree, '.npmrc') }, files())).toBeNull()
    expect(isCredentialPath('.npmrc', files())).toBe(false)
  })

  test('git add and git commit of the plain file', () => {
    expect(credentialReason('Bash', { command: 'git add .npmrc README.md && git commit -q -m "Add .npmrc"' }, files())).toBeNull()
    expect(credentialReason('Bash', { command: 'git log --oneline -3 -- .npmrc; cat .npmrc' }, files())).toBeNull()
  })

  test('with auth-like settings they are', () => {
    for (const p of ['tokened/.npmrc', 'auth/.npmrc', 'pw/.npmrc', 'user/.npmrc', 'ytoken/.yarnrc.yml']) {
      expect(cat(p), p).toMatch(/^Reads a credentials file/)
    }
  })

  test('relative paths start from the shell folder', () => {
    expect(cat('.npmrc', path.join(worktree, 'src'))).toBeNull() // src/.npmrc is plain
    expect(cat('.npmrc', path.join(worktree, 'tokened'))).toMatch(/^Reads a credentials file/)
    expect(cat('../.npmrc', path.join(worktree, 'src'))).toBeNull()
    expect(cat('../tokened/.npmrc', path.join(worktree, 'src'))).toMatch(/^Reads a credentials file/)
  })

  test('a file that is missing, unreadable, too big, outside the worktree or not a file is a credential', () => {
    expect(cat('missing/.npmrc')).toMatch(/^Reads a credentials file/)
    expect(cat('big/.npmrc')).toMatch(/^Reads a credentials file/)
    expect(cat(`${elsewhere}/.npmrc`)).toMatch(/^Reads a credentials file/)
    expect(cat('../other/.npmrc')).toMatch(/^Reads a credentials file/)
    fs.mkdirSync(path.join(worktree, 'asdir', '.npmrc'), { recursive: true })
    expect(cat('asdir/.npmrc')).toMatch(/^Reads a credentials file/)
  })

  test('without the worktree to read from they are credentials, as before', () => {
    expect(credentialReason('Bash', { command: 'cat .npmrc' })).toMatch(/^Reads a credentials file/)
    expect(isCredentialPath('.npmrc')).toBe(true)
    expect(isCredentialPath(path.join(worktree, '.npmrc'))).toBe(true)
  })

  test('a variable, ~, a wildcard or an NTFS spelling is a credential', () => {
    for (const p of ['$X/.npmrc', '~/.npmrc', '.npm*', '.npmrc.', '.npmrc:stream', '.npmrc::$DATA', '.[n]pmrc']) {
      expect(cat(p), p).toMatch(/^Reads a credentials file/)
    }
  })

  test('the other credential files and folders are always credentials', () => {
    for (const p of ['.env', '.pypirc', '.netrc', '.git-credentials', '.ssh/id_rsa', 'etc/npmrc', '.aws/credentials', 'a.pem']) {
      expect(cat(p), p).toMatch(/^Reads a credentials file/)
    }
  })

  test('printing credentials is unchanged', () => {
    expect(credentialReason('Bash', { command: 'env' }, files())).toMatch(/^Prints credentials/)
    expect(credentialReason('Bash', { command: 'npm config get //registry.npmjs.org/:_authToken' }, files())).toMatch(/^Prints credentials/)
  })

  test('the guard uses the files', () => {
    const ctx = { worktree, additionalDirectories: [], ownBranch: 'b' }
    expect(guardReason('Bash', { command: 'cat .npmrc' }, ctx)).toBeNull()
    expect(guardReason('Bash', { command: 'cat tokened/.npmrc' }, ctx)).toMatchObject({ kind: 'hard_stop', message: expect.stringContaining('credentials') })
    expect(guardReason('Read', { file_path: path.join(worktree, '.npmrc') }, ctx)).toBeNull()
    expect(guardReason('Read', { file_path: path.join(worktree, 'tokened', '.npmrc') }, ctx)).toMatchObject({ kind: 'hard_stop' })
    expect(guardReason('Bash', { command: 'cat .npmrc' }, { ...ctx, cwd: path.join(worktree, 'tokened') })).toMatchObject({ kind: 'hard_stop' })
    expect(guardReason('Bash', { command: 'git add .npmrc' }, { ...ctx, worktree: path.join(root, 'nowhere') })).toMatchObject({ kind: 'hard_stop' })
  })
})
