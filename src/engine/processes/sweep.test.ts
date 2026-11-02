import { spawn } from 'node:child_process'
import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { descendantsOf, endedNotice, ProcessSweeper, type ProcessInfo } from './sweep'

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
