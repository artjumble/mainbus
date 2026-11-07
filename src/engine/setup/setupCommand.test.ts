import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProcessSweeper, type ProcessInfo, type ProcessRef } from '../processes/sweep'
import { createSetupCommandRunner, type SetupCommandRequest } from './setupCommand'

// Only processes these tests start themselves, with `node -e`.

let tmp: string
let cwd: string
let tempDir: string

function node(code: string): string {
  return `node -e "${code.replace(/"/g, '\\"')}"`
}

function request(command: string, extra: Partial<SetupCommandRequest> = {}): SetupCommandRequest {
  return { command, cwd, tempDir, timeoutMs: 30_000, signal: new AbortController().signal, logPath: path.join(tmp, 'setup.log'), ...extra }
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-setupcmd-'))
  cwd = path.join(tmp, 'folder')
  tempDir = path.join(tmp, 'scratch')
  await fs.mkdir(cwd)
  await fs.mkdir(tempDir)
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
})

describe('the real setup command runner', () => {
  it('returns the exit code and the last 50 lines, and keeps all of the output in the log', async () => {
    const run = createSetupCommandRunner()
    const result = await run(request(node("for (let i = 1; i <= 120; i++) console.log('line ' + i); process.exit(3)")))

    expect(result).toMatchObject({ exitCode: 3, timedOut: false, aborted: false })
    expect(result.tail).toHaveLength(50)
    expect(result.tail.at(-1)).toBe('line 120')
    expect(result.tail[0]).toBe('line 71')
    const log = await fs.readFile(path.join(tmp, 'setup.log'), 'utf8')
    expect(log.split(/\r?\n/).filter(Boolean)).toHaveLength(120)
    expect(log).toContain('line 1\n')
  })

  it('runs in the folder, with the scratch folder as TEMP and TMP', async () => {
    const run = createSetupCommandRunner()
    const result = await run(request(node("console.log(process.cwd()); console.log(process.env.TEMP); console.log(process.env.TMP)")))

    expect(result.exitCode).toBe(0)
    const real = (p: string) => fs.realpath(p)
    expect(await real(result.tail[0]!)).toBe(await real(cwd))
    expect(result.tail[1]).toBe(tempDir)
    expect(result.tail[2]).toBe(tempDir)
  })

  it('ends a command that outlasts the timeout, through the sweeper', async () => {
    const sweeper = new OwnChildSweeper()
    const run = createSetupCommandRunner(sweeper)
    const result = await run(request(node('setInterval(() => {}, 1000)'), { timeoutMs: 700 }))

    expect(result).toMatchObject({ exitCode: null, timedOut: true, aborted: false })
    expect(sweeper.swept).toEqual(sweeper.asked)
    expect(sweeper.swept).toHaveLength(1)
  })

  it('ends a command when the signal aborts, through the sweeper', async () => {
    const sweeper = new OwnChildSweeper()
    const run = createSetupCommandRunner(sweeper)
    const controller = new AbortController()
    const running = run(request(node("console.log('up'); setInterval(() => {}, 1000)"), { signal: controller.signal }))
    await new Promise((r) => setTimeout(r, 700))
    controller.abort()
    const result = await running

    expect(result).toMatchObject({ exitCode: null, timedOut: false, aborted: true })
    expect(sweeper.swept).toEqual(sweeper.asked)
    expect(sweeper.swept).toHaveLength(1)
  })

  it('falls back to ending its own shell without a sweeper', async () => {
    const run = createSetupCommandRunner()
    const controller = new AbortController()
    controller.abort()
    const result = await run(request(node('setInterval(() => {}, 1000)'), { signal: controller.signal }))
    expect(result.aborted).toBe(true)
  })
})

/**
 * A sweeper that ends only the process the runner asks about, which the runner itself spawned: it takes the pid the
 * runner gives it (never one found in the process table) and ends that tree, so nothing else can be touched.
 */
class OwnChildSweeper extends ProcessSweeper {
  readonly asked: number[] = []
  readonly swept: number[] = []

  override async startTime(pid: number): Promise<number | null> {
    this.asked.push(pid)
    return Date.now()
  }

  override async sweep(root: ProcessRef): Promise<ProcessInfo[]> {
    this.swept.push(root.pid)
    if (process.platform === 'win32') await new Promise((resolve) => execFile('taskkill.exe', ['/PID', String(root.pid), '/T', '/F'], { windowsHide: true }, resolve))
    else process.kill(root.pid, 'SIGKILL')
    return []
  }
}
