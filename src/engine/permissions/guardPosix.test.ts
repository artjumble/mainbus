import { describe, expect, test } from 'vitest'
import { type GuardContext, guardReason, isCdInside } from './guard'
import { hostPathStyle, type PathStyle } from './paths'
import { rulesFromRequest } from './policy'

// Made-up roots; `exists` is stubbed so nothing touches the disk.
const SETUPS = [
  {
    style: 'darwin' as PathStyle,
    wt: '/Users/sam/Library/Application Support/Mainbus/work/repo/12-fix',
    scratch: '/Users/sam/Library/Application Support/Mainbus/scratch/repo/12-fix',
    home: '/Users/sam',
    shouty: '/USERS/SAM/LIBRARY/APPLICATION SUPPORT/MAINBUS/WORK/REPO/12-FIX',
  },
  {
    style: 'linux' as PathStyle,
    wt: '/home/sam/.local/share/mainbus/work/repo/12-fix',
    scratch: '/home/sam/.local/share/mainbus/scratch/repo/12-fix',
    home: '/home/sam',
    shouty: '/HOME/SAM/.LOCAL/SHARE/MAINBUS/WORK/REPO/12-FIX',
  },
]

describe.each(SETUPS)('guard on $style', ({ style, wt, scratch, home, shouty }) => {
  const ctx: GuardContext = {
    worktree: wt,
    additionalDirectories: [scratch],
    scratch,
    ownBranch: 'mainbus/12-fix',
    pathStyle: style,
    exists: () => true,
  }
  const bash = (command: string, c: GuardContext = ctx) => guardReason('Bash', { command }, c)
  const write = (file_path: string, c: GuardContext = ctx) => guardReason('Write', { file_path }, c)

  test('inside is silent', () => {
    expect(write(`${wt}/src/a.ts`)).toBeNull()
    expect(write('src/a.ts')).toBeNull()
    expect(bash(`cd "${wt}/src" && touch c.txt`)).toBeNull()
    expect(bash('rm -rf ./build')).toBeNull()
    expect(bash('echo hi > "$TMPDIR/out.txt"')).toBeNull()
  })

  test('outside shows native paths', () => {
    expect(write('/etc/hosts')?.message).toBe("Writes outside the ticket's folder: /etc/hosts")
    expect(bash('rm -rf /tmp/x')?.message).toMatch(/\/tmp\/x$/)
    const read = guardReason('Read', { file_path: '/etc/passwd' }, ctx)
    expect(read).toEqual({ kind: 'automatic', message: "Reads outside the ticket's folder: /etc/passwd" })
    for (const m of [write('/etc/hosts'), bash('rm -rf /tmp/x'), read]) {
      expect(m?.message).not.toMatch(/\\|C:/)
    }
  })

  test('case', () => {
    const typed = `${shouty}/a.ts`
    if (style === 'darwin') expect(write(typed)).toBeNull()
    else expect(write(typed)).toEqual({ kind: 'hard_stop', message: `Writes outside the ticket's folder: ${typed}` })
  })

  test('..', () => {
    expect(bash('rm ../x')?.message).toBe(`Writes outside the ticket's folder: ${wt.replace(/\/[^/]+$/, '')}/x`)
    expect(bash('cd ../../..', { ...ctx, cwd: `${wt}/a/b/c` })).toBeNull()
    expect(bash('cd ..')?.message).toBe(`Leaves the ticket's folder: ${wt.replace(/\/[^/]+$/, '')}`)
    const parent = wt.replace(/\/[^/]+\/[^/]+$/, '')
    expect(write(`${wt}/src/../../other`)?.message).toBe(`Writes outside the ticket's folder: ${parent}/repo/other`)
  })

  test('~ and $HOME are outside and shown as typed', () => {
    expect(bash('touch ~/x')?.message).toBe("Writes outside the ticket's folder: ~/x")
    expect(bash('cd ~')?.message).toBe("Leaves the ticket's folder: ~")
    expect(bash('cd')?.message).toBe("Leaves the ticket's folder: ~")
    expect(bash('rm -rf $HOME/x')?.kind).toBe('hard_stop')
    expect(bash('cat ~/.claude/settings.json')?.message).toContain('Touches the .claude folder')
    expect(bash('cp a ~root/x')?.message).toBe("Writes outside the ticket's folder: ~root/x")
    expect(isCdInside(['cd', '~root'], ctx)).toBe(false)
  })

  test('/c/... is a plain path, never a drive', () => {
    expect(bash('rm -rf /c/Users/u/x')?.message).toBe("Writes outside the ticket's folder: /c/Users/u/x")
    const odd = { ...ctx, worktree: '/c/work/x' }
    expect(bash('touch /c/work/x/a', odd)).toBeNull()
  })

  test('separators', () => {
    expect(write('src\\a.ts')).toBeNull()
    expect(write('..\\x')).toBeNull()
    expect(write('C:\\h\\x')).toBeNull() // one relative file name
    const dropped = { ...ctx, additionalDirectories: ['C:\\x'] }
    expect(write('/C:/x/a', dropped)?.message).toContain('Writes outside')
    expect(write('C:\\x\\a', dropped)).toBeNull() // still just a name in the worktree
  })

  test('normalises without touching the disk', () => {
    expect(write(`${wt}/./src//a.ts`)).toBeNull()
  })

  test('agent config', () => {
    expect(write(`${wt}/.claude/settings.json`)?.message).toBe(`Changes agent or git settings: ${wt}/.claude/settings.json`)
    expect(guardReason('Read', { file_path: `${home}/.claude/projects/p/s/tool-results/x.txt` }, ctx)).toBeNull()
    expect(guardReason('Read', { file_path: `${home}/.claude/projects/p/s/tool-results/a\\b` }, ctx)).toBeNull()
    expect(guardReason('Read', { file_path: `${home}/.claude/projects/p/s/x\\tool-results\\f` }, ctx)?.message).toContain('Reads outside')
    const upper = guardReason('Read', { file_path: `${home}/.CLAUDE/projects/p/s/tool-results/x.txt` }, ctx)
    if (style === 'darwin') expect(upper).toBeNull()
    else expect(upper?.message).toContain('Reads outside')
  })

  test('zsh-ish commands are parsed like bash', () => {
    for (const command of ['cat =(ls)', 'ls *(.)']) {
      const r = bash(command)
      expect(r === null || r.message.length > 0).toBe(true)
      expect(r?.message ?? '').not.toMatch(/\\|C:/)
    }
  })

  test('policy', () => {
    expect(isCdInside(['cd', `${wt}/src`], ctx)).toBe(true)
    expect(isCdInside(['cd', '/etc'], ctx)).toBe(false)
    const req = { toolName: 'Bash', input: { command: `cd "${wt}/src" && npm test` } }
    const patterns = rulesFromRequest('w', req, { folders: ctx }).map((r) => r.pattern)
    expect(patterns).toEqual(['npm test *'])
  })
})

describe('default style', () => {
  test('a context with no pathStyle behaves like the host', () => {
    const host = hostPathStyle()
    const wt = host === 'win32' ? 'C:\\h\\work' : '/h/work'
    const base = { worktree: wt, additionalDirectories: [], ownBranch: 'b' }
    const file = host === 'win32' ? 'C:\\h\\work\\a' : '/h/work/a'
    expect(guardReason('Write', { file_path: file }, base)).toBeNull()
    expect(guardReason('Write', { file_path: file }, { ...base, pathStyle: host })).toBeNull()
  })
})
