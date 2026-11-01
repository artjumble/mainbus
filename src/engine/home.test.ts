import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { invocationDir, resolveHome, scratchPathFor } from './home'

// Expectations are built with the same flavour of path module the code runs under.
const p = process.platform === 'win32' ? path.win32 : path.posix

describe('resolveHome', () => {
  it('uses MAINBUS_HOME when set', () => {
    const mb = p.resolve(p.sep, 'mb')
    const home = resolveHome({ MAINBUS_HOME: mb }, 'stable', 'C:\\Users\\x')
    expect(home.root).toBe(mb)
    expect(home.db).toBe(p.join(mb, 'mainbus.db'))
    expect(home.worktrees).toBe(p.join(mb, 'work'))
    expect(home.scratch).toBe(p.join(mb, 'scratch'))
    expect(home.backups).toBe(p.join(mb, 'backups'))
  })

  it('resolves a relative MAINBUS_HOME against the given directory', () => {
    const base = p.resolve(p.sep, 'work', 'repo')
    expect(resolveHome({ MAINBUS_HOME: 'tmp-home' }, 'dev', 'unused', base).root).toBe(p.join(base, 'tmp-home'))
    expect(resolveHome({ MAINBUS_HOME: p.join('..', 'h') }, 'dev', 'unused', base).root).toBe(p.resolve(base, '..', 'h'))
  })

  it('stable and dev default to different LOCALAPPDATA folders', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }
    const stable = resolveHome(env, 'stable', 'C:\\Users\\x')
    const dev = resolveHome(env, 'dev', 'C:\\Users\\x')
    expect(stable.root).toBe(p.join(env.LOCALAPPDATA, 'Mainbus'))
    expect(dev.root).toBe(p.join(env.LOCALAPPDATA, 'Mainbus-dev'))
    expect(stable.db).toBe(p.join(stable.root, 'mainbus.db'))
    expect(stable.worktrees).toBe(p.join(stable.root, 'work'))
    expect(dev.backups).toBe(p.join(dev.root, 'backups'))
  })

  it('falls back to ~/.mainbus without LOCALAPPDATA', () => {
    const stable = resolveHome({}, 'stable', p.join(p.sep, 'home', 'x'))
    const dev = resolveHome({}, 'dev', p.join(p.sep, 'home', 'x'))
    expect(stable.root).toBe(p.join(p.sep, 'home', 'x', '.mainbus'))
    expect(dev.root).toBe(p.join(p.sep, 'home', 'x', '.mainbus-dev'))
  })
})

describe('scratchPathFor', () => {
  it("is the worktree's workspace slug and folder name under scratch, outside every worktree", () => {
    const home = resolveHome({ MAINBUS_HOME: p.resolve(p.sep, 'mb') }, 'stable', 'unused')
    const wt = p.join(home.worktrees, 'my-repo', '8-run-a-ticket')
    const scratch = scratchPathFor(home, wt)
    expect(scratch).toBe(p.join(home.root, 'scratch', 'my-repo', '8-run-a-ticket'))
    expect(p.relative(home.worktrees, scratch).startsWith('..')).toBe(true)
  })
})

describe('invocationDir', () => {
  it("is npm's INIT_CWD only inside the named script", () => {
    const env = { npm_lifecycle_event: 'mainbus', INIT_CWD: '/where/typed' }
    expect(invocationDir(env, 'mainbus', '/pkg')).toBe('/where/typed')
    expect(invocationDir({ ...env, npm_lifecycle_event: 'dev' }, 'mainbus', '/pkg')).toBe('/pkg')
    expect(invocationDir({ npm_lifecycle_event: 'mainbus' }, 'mainbus', '/pkg')).toBe('/pkg')
    expect(invocationDir({}, 'mainbus', '/pkg')).toBe('/pkg')
  })
})
