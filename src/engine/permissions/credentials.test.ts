// .npmrc, .yarnrc and .yarnrc.yml are credentials only when they hold auth-like settings. The tests use real files in
// throwaway folders under the system temp folder (the ticket's scratch folder when an agent runs them).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { credentialReason, isCredentialPath } from './credentials'
import type { AllowRule } from '../../shared/domain'
import { type GuardContext, guardReason } from './guard'
import { isAllowed, rulesFromRequest } from './policy'

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

// macOS Keychain and Linux keyrings. Made-up paths only: `exists` is stubbed, nothing touches the disk.
describe('macOS Keychain and Linux keyrings', () => {
  type Req = { toolName: string; input: Record<string, unknown> }
  const SETUPS = {
    darwin: { style: 'darwin' as const, wt: '/Users/sam/Library/Application Support/Mainbus/work/repo/12-fix' },
    linux: { style: 'linux' as const, wt: '/home/sam/.local/share/mainbus/work/repo/12-fix' },
  }
  const ctxFor = (os: keyof typeof SETUPS): GuardContext => ({
    worktree: SETUPS[os].wt,
    additionalDirectories: [],
    scratch: `${SETUPS[os].wt}-scratch`,
    ownBranch: 'mainbus/12-fix',
    pathStyle: SETUPS[os].style,
    exists: () => true,
  })
  const sh = (command: string): Req => ({ toolName: 'Bash', input: { command } })
  const asRule = (toolName: string, pattern: string | null, i: number): AllowRule => ({
    id: `r${i}`,
    workspaceId: 'w',
    toolName,
    pattern,
  })

  const stops: [keyof typeof SETUPS, string, Req][] = [
    ['darwin', 'security find-generic-password -s foo -w', sh('security find-generic-password -s foo -w')],
    ['darwin', 'security find-generic-password -ga foo', sh('security find-generic-password -ga foo')],
    ['darwin', 'security find-generic-password -s foo (no -w)', sh('security find-generic-password -s foo')],
    ['darwin', 'security find-internet-password -w', sh('security find-internet-password -s github.com -w')],
    ['darwin', 'security find-internet-password -g', sh('security find-internet-password -g -s x')],
    ['darwin', 'security dump-keychain', sh('security dump-keychain')],
    ['darwin', 'security dump-keychain -d', sh('security dump-keychain -d login.keychain')],
    ['darwin', 'security export', sh('security export -k login.keychain -t identities -f pkcs12 -o x.p12')],
    ['darwin', 'security -i (interactive)', sh('security -i')],
    ['darwin', 'security -q before the subcommand', sh('security -q find-generic-password -w -s x')],
    ['darwin', 'security -p prompt before the subcommand', sh('security -p hi find-generic-password -w -s x')],
    ['darwin', 'full path to security', sh('/usr/bin/security find-generic-password -w -s x')],
    ['darwin', 'sudo security', sh('sudo security dump-keychain -d')],
    ['darwin', 'security in a chain', sh('npm test && security find-generic-password -w -s x')],
    ['darwin', 'cat of ~/Library/Keychains', sh('cat ~/Library/Keychains/login.keychain-db')],
    ['darwin', 'cp of the Keychains folder', sh('cp -r ~/Library/Keychains .')],
    ['darwin', 'sqlite3 on a keychain', sh('sqlite3 /Users/sam/Library/Keychains/login.keychain-db')],
    ['darwin', 'ls /Library/Keychains', sh('ls /Library/Keychains')],
    ['darwin', 'Read of a keychain', { toolName: 'Read', input: { file_path: '/Users/sam/Library/Keychains/login.keychain-db' } }],
    ['darwin', 'Glob in Keychains', { toolName: 'Glob', input: { pattern: '*', path: '/Users/sam/Library/Keychains' } }],
    ['linux', 'secret-tool lookup', sh('secret-tool lookup service github')],
    ['linux', 'secret-tool search', sh('secret-tool search --all service github')],
    ['linux', 'cat of a keyring file', sh('cat ~/.local/share/keyrings/login.keyring')],
    ['linux', 'tar of the keyrings folder', sh('tar czf k.tgz ~/.local/share/keyrings')],
    ['linux', 'Read of a keyring', { toolName: 'Read', input: { file_path: '/home/sam/.local/share/keyrings/login.keyring' } }],
    ['linux', 'pass show', sh('pass show github')],
    ['linux', 'pass (implicit show)', sh('pass github')],
    ['linux', 'pass -c', sh('pass -c github')],
    ['linux', 'pass grep', sh('pass grep token')],
    ['linux', 'pass otp', sh('pass otp github')],
    ['linux', 'cat of the pass store', sh('cat ~/.password-store/github.gpg')],
    ['linux', 'gpg -d of the pass store', sh('gpg -d ~/.password-store/github.gpg')],
    ['linux', 'a wildcard for the pass store', sh('ls ~/.pass*')],
    ['linux', 'Glob in the pass store', { toolName: 'Glob', input: { pattern: '*', path: '/home/sam/.password-store' } }],
  ]

  test.each(stops)('%s: %s is a hard stop with no Always allow', (os, _name, req) => {
    expect(credentialReason(req.toolName, req.input, { worktree: SETUPS[os].wt, pathStyle: SETUPS[os].style })).toMatch(
      /^(?:Prints credentials|Reads a credentials file): /,
    )
    const reason = guardReason(req.toolName, req.input, ctxFor(os))
    expect(reason).toMatchObject({ kind: 'hard_stop', message: expect.stringMatching(/^(?:Prints credentials|Reads a credentials file): /) })
    const saved = [...rulesFromRequest('w', req), ...rulesFromRequest('w', req, { exact: true })]
    const rules = [...saved, asRule(req.toolName, null, 99)].map((r, i) => ({ ...r, id: `r${i}` }))
    expect(isAllowed(rules, req)).toBe(false)
  })

  const quiet = [
    'security list-keychains',
    'security find-identity -v -p codesigning',
    'security find-certificate -c "Apple Development"',
    'security default-keychain',
    'security cms -D -i profile.mobileprovision',
    'security',
    'security help',
    'secret-tool store --label=x service y',
    'secret-tool clear service y',
    'pass',
    'pass ls',
    'pass find github',
    'pass --version',
    'cat /usr/share/keyrings/debian-archive-keyring.gpg',
    'ls ~/Library/Preferences',
    'grep -rn find-generic-password src',
    'echo security dump-keychain',
    'git commit -m "security dump-keychain"',
  ]

  test.each(quiet)('%s is not flagged', (command) => {
    expect(credentialReason('Bash', { command })).toBeNull()
    // Some rows read outside the worktree, which is its own (automatic) reason; none may be a credentials stop.
    for (const os of ['darwin', 'linux'] as const) {
      expect(guardReason('Bash', { command }, ctxFor(os))?.kind).not.toBe('hard_stop')
      expect(guardReason('Bash', { command }, ctxFor(os))?.message ?? '').not.toMatch(/credentials/)
    }
  })
})
