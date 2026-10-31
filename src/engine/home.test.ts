import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveHome } from './home'

// Expectations are built with the same flavour of path module the code runs under.
const p = process.platform === 'win32' ? path.win32 : path.posix

describe('resolveHome', () => {
  it('uses MAINBUS_HOME when set', () => {
    const home = resolveHome({ MAINBUS_HOME: 'D:\\mb' }, 'stable', 'C:\\Users\\x')
    expect(home.root).toBe('D:\\mb')
    expect(home.db).toBe(p.join('D:\\mb', 'mainbus.db'))
    expect(home.worktrees).toBe(p.join('D:\\mb', 'work'))
    expect(home.backups).toBe(p.join('D:\\mb', 'backups'))
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
