// Runs the real scripts/install-stable.sh against a temporary data home (never the real one), with a home
// path that has a space and quotes, and a fake Mainbus.app. Skipped on Windows, which has no POSIX shell.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const scripts = path.join(import.meta.dirname, '..', '..', 'scripts')

describe.runIf(process.platform !== 'win32')('stable build scripts', () => {
  let tmp: string
  let home: string
  let app: string
  const install = (name: string) =>
    spawnSync('sh', [path.join(scripts, 'install-stable.sh'), app, home, name], {
      encoding: 'utf8',
      env: { ...process.env, MAINBUS_AGENT: '' }
    })
  const read = (...p: string[]) => fs.readFileSync(path.join(home, ...p), 'utf8')
  const builds = () =>
    fs.existsSync(path.join(home, 'app'))
      ? fs.readdirSync(path.join(home, 'app')).filter((f) => /^\d{8}-/.test(f)).sort()
      : []

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-install-'))
    home = path.join(tmp, `Application Support's "Mainbus"`)
    app = path.join(tmp, 'built', 'Mainbus.app')
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
    fs.mkdirSync(path.join(app, 'Contents', 'Resources', 'cli'), { recursive: true })
    fs.symlinkSync(process.execPath, path.join(app, 'Contents', 'MacOS', 'Mainbus'))
    fs.writeFileSync(
      path.join(app, 'Contents', 'Resources', 'cli', 'mainbus.cjs'),
      'process.stdout.write(JSON.stringify(process.argv.slice(2)))'
    )
  })

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('all four scripts parse', () => {
    for (const f of ['mainbus', 'build-stable.sh', 'run-stable.sh', 'install-stable.sh']) {
      expect(spawnSync('sh', ['-n', path.join(scripts, f)]).status).toBe(0)
    }
  })

  it('installs the first build with its pointer and a working launcher', () => {
    const r = install('20261122-1000-a1')
    expect(r.status).toBe(0)
    expect(read('app', 'current.txt')).toBe('20261122-1000-a1')
    expect(fs.existsSync(path.join(home, 'app', 'previous.txt'))).toBe(false)
    const bin = path.join(home, 'bin', 'mainbus')
    expect(fs.statSync(bin).mode & 0o111).not.toBe(0)
    const run = spawnSync(bin, ['ticket', 'list'], { encoding: 'utf8' })
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual(['ticket', 'list'])
  })

  it('leaves an unchanged launcher alone', () => {
    const bin = path.join(home, 'bin', 'mainbus')
    const before = fs.statSync(bin)
    expect(install('20261122-1001-a2').status).toBe(0)
    const after = fs.statSync(bin)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(read('app', 'previous.txt')).toBe('20261122-1000-a1')
    expect(read('app', 'current.txt')).toBe('20261122-1001-a2')
  })

  it('removes interrupted-install leftovers, and keeps the 3 newest builds plus the rollback target', () => {
    fs.mkdirSync(path.join(home, 'app', '20261122-0900-old.tmp'))
    for (const n of ['3', '4', '5']) expect(install(`20261122-100${n}-a${n}`).status).toBe(0)
    expect(fs.existsSync(path.join(home, 'app', '20261122-0900-old.tmp'))).toBe(false)
    expect(builds()).toEqual(['20261122-1003-a3', '20261122-1004-a4', '20261122-1005-a5'])
    expect(read('app', 'previous.txt')).toBe('20261122-1004-a4')
  })

  it('refuses a bad name and writes nothing', () => {
    const before = builds()
    expect(install('../evil').status).not.toBe(0)
    expect(install('latest').status).not.toBe(0)
    expect(builds()).toEqual(before)
  })

  it('refuses to run inside a Mainbus agent', () => {
    const fresh = path.join(tmp, 'agent-home')
    const env = { ...process.env, MAINBUS_AGENT: '1' }
    const r = spawnSync('sh', [path.join(scripts, 'install-stable.sh'), app, fresh, '20261122-1200-x'], {
      encoding: 'utf8',
      env
    })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('MAINBUS_AGENT')
    expect(fs.existsSync(fresh)).toBe(false)
    for (const f of ['build-stable.sh', 'run-stable.sh']) {
      const s = spawnSync('sh', [path.join(scripts, f)], { encoding: 'utf8', env })
      expect(s.status).not.toBe(0)
      expect(s.stderr).toContain('MAINBUS_AGENT')
    }
  })
})
