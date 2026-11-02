import { spawn } from 'node:child_process'
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
    const sleeper = "setInterval(() => {}, 1000)"
    // The child starts a grandchild (which sleeps) and is then ended; the grandchild stays.
    const child = spawn(
      process.execPath,
      ['-e', `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(sleeper)}], { stdio: 'ignore', detached: true, windowsHide: true }); setInterval(() => {}, 1000)`],
      { stdio: 'ignore', windowsHide: true }
    )
    const bystander = spawn(process.execPath, ['-e', sleeper], { stdio: 'ignore', windowsHide: true })
    const sweeper = new ProcessSweeper()
    // The same table, but ending nothing: it shows what a sweep would find.
    const lookup = new ProcessSweeper(undefined, async () => {})
    try {
      const pid = child.pid!
      let startedAt: number | null = null
      let grandchild: number | undefined
      for (let i = 0; i < 100 && grandchild === undefined; i++) {
        await new Promise((r) => setTimeout(r, 200))
        startedAt = await lookup.startTime(pid)
        if (startedAt !== null) grandchild = (await lookup.sweep({ pid, startedAt })).find((p) => p.pid !== pid && /^node\.exe$/i.test(p.name))?.pid
      }
      expect(startedAt).not.toBeNull()
      expect(grandchild).toBeDefined()

      child.kill()
      await new Promise((r) => child.once('exit', r))
      expect(isRunning(grandchild!)).toBe(true)

      const ended = await sweeper.sweep({ pid, startedAt: startedAt! })

      expect(ended.map((p) => p.pid)).toContain(grandchild)
      await waitUntil(() => !isRunning(grandchild!))
      expect(isRunning(bystander.pid!)).toBe(true)
    } finally {
      bystander.kill()
      child.kill()
    }
  }, 60_000)
})

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
