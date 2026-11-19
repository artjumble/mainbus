import { execFileSync, spawn } from 'node:child_process'
import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { descendantsOf, endedNotice, endProcessGroup, parsePsTable, ProcessSweeper, type ProcessInfo } from './sweep'

const T = 1_000_000
const proc = (pid: number, parentPid: number, createdAt: number, name = `p${pid}.exe`): ProcessInfo => ({ pid, parentPid, name, createdAt })
const pids = (ps: ProcessInfo[]): number[] => ps.map((p) => p.pid).sort((a, b) => a - b)

describe('descendantsOf', () => {
  const root = { pid: 100, startedAt: T }

  it('finds children and grandchildren through a root that has exited', () => {
    const table = [proc(200, 100, T + 10), proc(300, 200, T + 20), proc(301, 200, T + 30), proc(400, 1, T + 5), proc(500, 400, T + 40)]
    expect(pids(descendantsOf(table, root))).toEqual([200, 300, 301])
  })

  it('finds the descendants of a root that is still running, and the root itself', () => {
    const table = [proc(100, 1, T), proc(200, 100, T + 10)]
    expect(pids(descendantsOf(table, root))).toEqual([100, 200])
  })

  it('leaves alone a process created before its supposed parent (a reused process id)', () => {
    // 200 was created before 100's descendant 150, yet names 150 as its parent: 150's id was reused.
    const table = [proc(150, 100, T + 50), proc(200, 150, T + 10), proc(250, 100, T - 5)]
    expect(pids(descendantsOf(table, root))).toEqual([150])
  })

  it('leaves alone what was created before the root started', () => {
    expect(descendantsOf([proc(200, 100, T - 1)], root)).toEqual([])
  })

  it('does not take the children of a different process that now has the root id', () => {
    // 100 is running again, but started long after the stored start: it is somebody else.
    const table = [proc(100, 1, T + 100_000), proc(200, 100, T + 100_010), proc(201, 100, T + 50)]
    expect(pids(descendantsOf(table, root))).toEqual([201])
  })

  it('never returns a process outside the tree, and survives a cycle', () => {
    const table = [proc(200, 100, T + 10), proc(300, 200, T + 20), proc(300, 300, T + 20), proc(900, 800, T + 30)]
    expect(pids(descendantsOf(table, root))).toEqual([200, 300])
  })
})

describe('endedNotice', () => {
  it('names each process, with a count when there are several', () => {
    const ended = [proc(1, 0, 0, 'python3.exe'), proc(2, 0, 0, 'bash.exe'), proc(3, 0, 0, 'bash.exe'), proc(4, 0, 0, 'bash.exe')]
    expect(endedNotice('Implementer', ended)).toBe('Mainbus ended 4 processes the Implementer left running: python3.exe, bash.exe (3).')
    expect(endedNotice('Reviewer', ended.slice(0, 1))).toBe('Mainbus ended 1 process the Reviewer left running: python3.exe.')
  })

  it('is null when nothing was ended', () => {
    expect(endedNotice('Implementer', [])).toBeNull()
  })
})

describe('ProcessSweeper', () => {
  it('ends only the descendants it found', async () => {
    const killed: number[] = []
    const table = [proc(200, 100, T + 10), proc(900, 800, T + 30)]
    const sweeper = new ProcessSweeper(async () => table, async (ps) => void killed.push(...ps.map((p) => p.pid)))
    expect(pids(await sweeper.sweep({ pid: 100, startedAt: T }))).toEqual([200])
    expect(killed).toEqual([200])
  })

  it('ends nothing, and does not call kill, when there are no descendants', async () => {
    let called = false
    const sweeper = new ProcessSweeper(async () => [proc(900, 800, T)], async () => void (called = true))
    expect(await sweeper.sweep({ pid: 100, startedAt: T })).toEqual([])
    expect(called).toBe(false)
  })
})

const gproc = (pid: number, parentPid: number, groupId: number, createdAt: number): ProcessInfo => ({ ...proc(pid, parentPid, createdAt), groupId })

describe('descendantsOf with process groups', () => {
  const root = { pid: 100, startedAt: T }

  it('finds group members re-parented to init after the root exited', () => {
    const table = [gproc(200, 1, 100, T + 10), gproc(201, 1, 100, T + 20), gproc(900, 1, 900, T + 10), gproc(901, 1, 1, T + 10)]
    expect(pids(descendantsOf(table, root))).toEqual([200, 201])
  })

  it('finds the descendants of a group member that started its own group', () => {
    const table = [gproc(200, 1, 100, T + 10), gproc(300, 200, 300, T + 20), gproc(400, 300, 400, T + 30), gproc(900, 1, 900, T + 30)]
    expect(pids(descendantsOf(table, root))).toEqual([200, 300, 400])
  })

  it('matches nothing by group when the root pid is alive with another start time', () => {
    const table = [gproc(100, 1, 100, T + 100_000), gproc(200, 1, 100, T + 100_010)]
    expect(descendantsOf(table, root)).toEqual([])
  })

  it('ignores a group member created before the root', () => {
    expect(descendantsOf([gproc(200, 1, 100, T - 60_000)], root)).toEqual([])
  })

  it('keeps a member whose start time was truncated to the second', () => {
    expect(pids(descendantsOf([gproc(200, 1, 100, T - 900)], root))).toEqual([200])
  })

  it('never returns Mainbus itself', () => {
    expect(descendantsOf([gproc(process.pid, 1, 100, T + 10)], root)).toEqual([])
  })

  it('does not match by group on rows without a group id', () => {
    expect(descendantsOf([proc(200, 1, T + 10)], root)).toEqual([])
  })
})

describe('parsePsTable', () => {
  it('parses Linux and macOS rows, with group ids', () => {
    const out = [
      '    1     0     1 Thu Nov 19 13:49:16 2026 systemd',
      '  580   579   580 Thu Nov 19 13:49:16 2026 sh',
      '12345     1 12345 Wed Nov  5 09:01:02 2026 /Applications/Visual Studio Code.app/Contents/MacOS/Electron',
      'garbage line',
      '  7 8 Thu Nov 19 13:49:16 2026 missing-pgid'
    ].join('\n')
    const rows = parsePsTable(out)
    expect(rows.map((r) => [r.pid, r.parentPid, r.groupId])).toEqual([
      [1, 0, 1],
      [580, 579, 580],
      [12345, 1, 12345]
    ])
    expect(rows[2]!.name).toBe('/Applications/Visual Studio Code.app/Contents/MacOS/Electron')
    expect(rows[1]!.createdAt).toBe(Date.parse('Thu Nov 19 13:49:16 2026'))
  })
})

describe('endProcessGroup', () => {
  const root = { pid: 100, startedAt: T }
  const setup = (dead: (calls: [number, string | number][]) => (pid: number) => boolean) => {
    const calls: [number, string | number][] = []
    const isDead = dead(calls)
    const signal = (pid: number, sig: NodeJS.Signals | 0): void => {
      calls.push([pid, sig])
      if (sig === 0 && isDead(pid)) throw new Error('ESRCH')
    }
    let now = 0
    const sleep = async (ms: number): Promise<void> => void (now += ms)
    return { calls, opts: { graceMs: 300, pollMs: 100, signal, sleep }, now: () => now }
  }
  const found = [gproc(200, 1, 100, T + 10), gproc(201, 1, 100, T + 10), gproc(300, 1, 300, T + 10)]

  it('terms the group and loose pids, then kills only what is still alive', async () => {
    const s = setup((calls) => (pid) => pid === 200 || (pid === 300 && calls.some(([p, sg]) => p === 300 && sg === 'SIGTERM')))
    // 201 ignores TERM; 200 and 300 exit.
    await endProcessGroup(found, root, s.opts)
    const real = s.calls.filter(([, sg]) => sg !== 0)
    expect(real).toEqual([
      [-100, 'SIGTERM'],
      [300, 'SIGTERM'],
      [-100, 'SIGKILL'],
      [201, 'SIGKILL']
    ])
  })

  it('does not kill when everything exits after TERM', async () => {
    const s = setup(() => () => true)
    await endProcessGroup(found, root, s.opts)
    expect(s.calls.filter(([, sg]) => sg === 'SIGKILL')).toEqual([])
  })

  it('only signals the group and found pids', async () => {
    const s = setup(() => () => false)
    await endProcessGroup(found, root, s.opts)
    const allowed = new Set([-100, 200, 201, 300])
    expect(s.calls.every(([pid]) => allowed.has(pid))).toBe(true)
  })

  it('does not signal a group when no found process belongs to it', async () => {
    const s = setup(() => () => true)
    await endProcessGroup([gproc(300, 1, 300, T + 10)], root, s.opts)
    expect(s.calls.some(([pid]) => pid < 0)).toBe(false)
  })
})

describe('ProcessSweeper passes the root to kill', () => {
  it('hands kill the root it swept', async () => {
    let seen: unknown
    const sweeper = new ProcessSweeper(async () => [proc(200, 100, T + 10)], async (_p, r) => void (seen = r))
    await sweeper.sweep({ pid: 100, startedAt: T })
    expect(seen).toEqual({ pid: 100, startedAt: T })
  })
})

describe.runIf(process.platform !== 'win32')('ProcessSweeper on POSIX, with real processes', () => {
  it('ends orphans that outlived their parent, including one that ignores SIGTERM, and nothing else', async () => {
    const cwd = os.tmpdir()
    const stubborn = `process.on('SIGTERM', () => {}); ${SLEEPER}`
    const childScript =
      `const cp = require('child_process'); const out = [];` +
      `for (const code of [${JSON.stringify(SLEEPER)}, ${JSON.stringify(stubborn)}]) out.push(cp.spawn(process.execPath, ['-e', code], { stdio: 'ignore' }).pid);` +
      `process.stdout.write('grandchildren ' + out.join(',') + '\\n'); setTimeout(() => process.exit(0), 300)`
    const child = spawn(process.execPath, ['-e', childScript], { cwd, stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    const plain = spawn(process.execPath, ['-e', SLEEPER], { cwd, stdio: 'ignore' })
    const other = spawn(process.execPath, ['-e', SLEEPER], { cwd, stdio: 'ignore', detached: true })
    let reported = ''
    child.stdout!.on('data', (d) => (reported += d))
    const sweeper = new ProcessSweeper(undefined, (p, r) => endProcessGroup(p, r, { graceMs: 500 }))
    let grandchildren: number[] = []
    try {
      const startedAt = (await new ProcessSweeper().startTime(child.pid!)) ?? Date.now()
      await new Promise((r) => child.once('exit', r))
      grandchildren = (/grandchildren ([\d,]+)/.exec(reported)?.[1] ?? '').split(',').map(Number)
      expect(grandchildren).toHaveLength(2)
      expect(grandchildren.every(isAlive)).toBe(true)
      const ended = await sweeper.sweep({ pid: child.pid!, startedAt })
      expect(pids(ended)).toEqual([...grandchildren].sort((a, b) => a - b))
      await waitUntil(() => grandchildren.every((g) => !isAlive(g)))
      expect(isAlive(plain.pid!)).toBe(true)
      expect(isAlive(other.pid!)).toBe(true)
    } finally {
      plain.kill('SIGKILL')
      try {
        process.kill(-other.pid!, 'SIGKILL')
      } catch {
        // gone
      }
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // gone
      }
    }
  }, 60_000)
})

// Running, and not a zombie that nobody has reaped yet.
function isAlive(pid: number): boolean {
  if (!isRunning(pid)) return false
  try {
    return !/^Z/.test(execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim())
  } catch {
    return false
  }
}

describe.runIf(process.platform === 'win32')('ProcessSweeper on Windows, with real processes', () => {
  it('ends a grandchild that outlived its parent, and nothing else', async () => {
    await runScenario({ failBeforeSweep: false })
  }, 60_000)

  it('leaves none of the processes it started running when it fails before the sweep', async () => {
    const started: { child: number; grandchild?: number; bystander: number } = { child: 0, bystander: 0 }
    await expect(runScenario({ failBeforeSweep: true }, started)).rejects.toThrow('forced failure')
    expect(started.grandchild).toBeDefined()
    await waitUntil(() => !isRunning(started.child) && !isRunning(started.grandchild!) && !isRunning(started.bystander))
  }, 60_000)
})

const SLEEPER = 'setInterval(() => {}, 1000)'

// Starts a child that starts a grandchild, then ends the child and sweeps. Whatever happens, every process
// it started is ended. They all run in the system temp folder, so a leak cannot hold a worktree open.
async function runScenario(
  { failBeforeSweep }: { failBeforeSweep: boolean },
  started: { child: number; grandchild?: number; bystander: number } = { child: 0, bystander: 0 }
): Promise<void> {
  const cwd = os.tmpdir()
  // The child starts a grandchild (which sleeps), reports its id on stdout, and stays; it is then ended and the grandchild stays.
  const childScript =
    `const g = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(SLEEPER)}], { stdio: 'ignore', detached: true, windowsHide: true });` +
    `process.stdout.write('grandchild ' + g.pid + '\\n'); setInterval(() => {}, 1000)`
  const child = spawn(process.execPath, ['-e', childScript], { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  const bystander = spawn(process.execPath, ['-e', SLEEPER], { cwd, stdio: 'ignore', windowsHide: true })
  started.child = child.pid!
  started.bystander = bystander.pid!
  let reported = ''
  child.stdout!.on('data', (d) => {
    reported += d
    const m = /grandchild (\d+)/.exec(reported)
    if (m) started.grandchild = Number(m[1])
  })
  const sweeper = new ProcessSweeper()
  // The same table, but ending nothing: it shows what a sweep would find.
  const lookup = new ProcessSweeper(undefined, async () => {})
  let startedAt: number | null = null
  let grandchildEnded = false
  try {
    const pid = child.pid!
    let found: number | undefined
    // Give up well inside the test's own limit, so this `finally` always runs before Vitest times the test out.
    const deadline = Date.now() + 30_000
    while (found === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
      startedAt = await lookup.startTime(pid)
      if (startedAt !== null && started.grandchild !== undefined) {
        found = (await lookup.sweep({ pid, startedAt })).find((p) => p.pid === started.grandchild)?.pid
      }
    }
    expect(startedAt).not.toBeNull()
    expect(found).toBeDefined()
    const grandchild = found!
    if (failBeforeSweep) throw new Error('forced failure')

    child.kill()
    await new Promise((r) => child.once('exit', r))
    expect(isRunning(grandchild)).toBe(true)

    const ended = await sweeper.sweep({ pid, startedAt: startedAt! })
    grandchildEnded = true

    expect(ended.map((p) => p.pid)).toContain(grandchild)
    await waitUntil(() => !isRunning(grandchild))
    expect(isRunning(bystander.pid!)).toBe(true)
  } finally {
    bystander.kill()
    child.kill()
    if (startedAt !== null) await sweeper.sweep({ pid: child.pid!, startedAt }).catch(() => [])
    // Only a grandchild still running, and not already ended by the sweep (its id may be reused), is ended directly.
    if (!grandchildEnded && started.grandchild !== undefined && isRunning(started.grandchild)) {
      try {
        process.kill(started.grandchild)
      } catch {
        // already gone
      }
    }
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(done: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !done(); i++) await new Promise((r) => setTimeout(r, 100))
  expect(done()).toBe(true)
}
