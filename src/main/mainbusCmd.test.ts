// Runs the real scripts\mainbus.cmd from an install folder whose path has the characters that break cmd
// scripts: ( ) & and !. Node stands in for Mainbus.exe, and a stub prints what the launcher handed it.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const script = path.join(import.meta.dirname, '..', '..', 'scripts', 'mainbus.cmd')

describe.runIf(process.platform === 'win32')('mainbus.cmd', () => {
  let tmp: string
  let root: string
  let launcher: string

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-cmd-'))
    root = path.join(tmp, 'Mainbus (x86) & co!')
    launcher = path.join(root, 'bin', 'mainbus.cmd')
    fs.mkdirSync(path.dirname(launcher), { recursive: true })
    fs.copyFileSync(script, launcher)
    const build = path.join(root, 'app', 'b1')
    fs.mkdirSync(path.join(build, 'resources', 'cli'), { recursive: true })
    const exe = path.join(build, 'Mainbus.exe')
    try {
      fs.linkSync(process.execPath, exe)
    } catch {
      fs.copyFileSync(process.execPath, exe)
    }
    fs.writeFileSync(
      path.join(build, 'resources', 'cli', 'mainbus.cjs'),
      'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), node: process.env.ELECTRON_RUN_AS_NODE }));' +
        'process.stderr.write("to stderr");process.exitCode = 7'
    )
  })

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  /** cmd /s /c "<line>": the outer quotes are stripped and the rest runs as typed. */
  const run = (...args: string[]) =>
    spawnSync('cmd.exe', ['/d', '/s', '/c', `""${launcher}" ${args.join(' ')}"`], {
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: true
    })

  it('runs the current build in Node mode, passing arguments, output and the exit code through', () => {
    fs.writeFileSync(path.join(root, 'app', 'current.txt'), 'b1\r\n')
    const r = run('ticket', 'show', '"two words"', '--json')
    expect(JSON.parse(r.stdout)).toEqual({ args: ['ticket', 'show', 'two words', '--json'], node: '1' })
    expect(r.stderr).toBe('to stderr')
    expect(r.status).toBe(7)
  })

  it('says which build has no CLI, with the path, and exits 3', () => {
    fs.writeFileSync(path.join(root, 'app', 'current.txt'), 'b2\r\n')
    const r = run('ticket', 'list')
    expect(r.status).toBe(3)
    expect(r.stderr).toContain(`Mainbus build b2 has no CLI: ${root}\\bin\\..\\app\\b2\\resources\\cli\\mainbus.cjs is missing`)
  })

  it('says it is not installed, with the path, and exits 3', () => {
    fs.rmSync(path.join(root, 'app', 'current.txt'))
    const r = run('ticket', 'list')
    expect(r.status).toBe(3)
    expect(r.stderr).toContain(`Mainbus isn't installed: ${root}\\bin\\..\\app\\current.txt is missing`)
  })
})
