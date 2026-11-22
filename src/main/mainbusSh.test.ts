// Runs the real scripts/mainbus from an install folder whose path has characters that break shell scripts:
// a space, quotes, $, & ( ) and !. Node stands in for the Mainbus binary, and a stub prints what the launcher
// handed it. Also checks that the macOS shell scripts are stored with LF endings and the exec bit.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repo = path.join(import.meta.dirname, '..', '..')
const script = path.join(repo, 'scripts', 'mainbus')
const SCRIPTS = ['scripts/mainbus', 'scripts/build-stable.sh', 'scripts/run-stable.sh', 'scripts/install-stable.sh']

describe('shell scripts in git', () => {
  it('are executable and have LF endings', () => {
    const modes = spawnSync('git', ['ls-files', '-s', ...SCRIPTS], { cwd: repo, encoding: 'utf8' })
    if (modes.status !== 0) return // not a git checkout
    for (const f of SCRIPTS) expect(modes.stdout).toMatch(new RegExp(`^100755 .*\\t${f}$`, 'm'))
    const eol = spawnSync('git', ['ls-files', '--eol', ...SCRIPTS], { cwd: repo, encoding: 'utf8' }).stdout
    for (const line of eol.trim().split('\n')) expect(line).toMatch(/^i\/lf /)
  })
})

describe.runIf(process.platform !== 'win32')('scripts/mainbus', () => {
  let tmp: string
  let root: string
  let launcher: string
  const pointer = () => path.join(root, 'app', 'current.txt')

  const makeBuild = (name: string, cli = true): void => {
    const contents = path.join(root, 'app', name, 'Mainbus.app', 'Contents')
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true })
    fs.symlinkSync(process.execPath, path.join(contents, 'MacOS', 'Mainbus'))
    if (!cli) return
    fs.mkdirSync(path.join(contents, 'Resources', 'cli'), { recursive: true })
    fs.writeFileSync(
      path.join(contents, 'Resources', 'cli', 'mainbus.cjs'),
      `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), node: process.env.ELECTRON_RUN_AS_NODE, build: ${JSON.stringify(name)} }));` +
        'process.stderr.write("to stderr");process.exitCode = 7'
    )
  }

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-sh-'))
    root = path.join(tmp, `Mainbus "q" it's $HOME & (x)!`)
    launcher = path.join(root, 'bin', 'mainbus')
    fs.mkdirSync(path.dirname(launcher), { recursive: true })
    fs.copyFileSync(script, launcher)
    fs.chmodSync(launcher, 0o755)
    makeBuild('b1')
    makeBuild('b2')
    makeBuild('nocli', false)
  })

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const run = (...args: string[]) => spawnSync(launcher, args, { encoding: 'utf8' })

  it('runs the current build in Node mode, passing arguments, output and the exit code through', () => {
    fs.writeFileSync(pointer(), 'b1\n')
    const args = ['ticket', 'show', 'two words', "it's", '"q"', '$HOME', '*', '', '--json']
    const r = run(...args)
    expect(JSON.parse(r.stdout)).toEqual({ args, node: '1', build: 'b1' })
    expect(r.stderr).toBe('to stderr')
    expect(r.status).toBe(7)
  })

  it('reads a pointer with CRLF or without a trailing newline, and follows a change', () => {
    fs.writeFileSync(pointer(), 'b1\r\n')
    expect(JSON.parse(run('x').stdout).build).toBe('b1')
    fs.writeFileSync(pointer(), 'b2')
    expect(JSON.parse(run('x').stdout).build).toBe('b2')
  })

  it('says which build has no CLI, with the path, and exits 3', () => {
    fs.writeFileSync(pointer(), 'nocli\n')
    const r = run('ticket', 'list')
    expect(r.status).toBe(3)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('nocli')
    expect(r.stderr).toContain(path.join(root, 'app', 'nocli', 'Mainbus.app', 'Contents', 'Resources', 'cli', 'mainbus.cjs'))
  })

  it('says it is not installed when the pointer is missing or empty, and exits 3', () => {
    fs.rmSync(pointer())
    const missing = run('ticket', 'list')
    expect(missing.status).toBe(3)
    expect(missing.stderr).toContain('current.txt')
    fs.writeFileSync(pointer(), '')
    expect(run('ticket', 'list').status).toBe(3)
  })
})
