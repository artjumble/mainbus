import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent } from '../../shared/api'
import type { TestCommand, Workspace } from '../../shared/domain'
import { FakeClock } from '../holds/clock'
import type { SetupCommandRequest, SetupCommandResult } from '../setup/setupCommand'
import type { BaseTestRun } from '../store/baseTests'
import { BaseTestMonitor } from './monitor'
import { eventually } from '../testWait'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mainbus-basemon-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const junit = (failing: string[]): string =>
  `<testsuites><testsuite>${['ok', ...failing].map((n) => (n === 'ok' ? '<testcase classname="t" name="ok"/>' : `<testcase classname="t" name="${n}"><failure/></testcase>`)).join('')}</testsuite></testsuites>`

type Behaviour = (req: SetupCommandRequest, n: number) => Promise<Partial<SetupCommandResult> & { writes?: string }>

function setup(opts: { commands?: TestCommand[]; workspaces?: Partial<Workspace>[]; behaviour?: Behaviour } = {}) {
  const clock = new FakeClock(new Date('2026-11-07T10:00:00Z'))
  const emitted: EngineEvent[] = []
  const stored: BaseTestRun[] = []
  const commands = opts.commands ?? [{ name: 'Unit', command: 'run <results>', format: 'junit-xml' as const }]
  const workspaces = (opts.workspaces ?? [{ id: 'w1', slug: 'w1' }]).map(
    (w) => ({ repoPath: '/r', baseBranch: 'main', setupCommand: '', setupTimeoutMinutes: 15, testCommands: commands, ...w }) as Workspace
  )
  let sha = 'aaa1111'
  let working = false
  let started = 0
  const calls: SetupCommandRequest[] = []
  const ran: string[] = []
  const behaviour: Behaviour = opts.behaviour ?? (async () => ({ exitCode: 1, writes: junit(['bad']) }))
  const run = vi.fn(async (req: SetupCommandRequest): Promise<SetupCommandResult> => {
    calls.push(req)
    const n = started++
    ran.push(req.command)
    const out = await behaviour(req, n)
    const file = /"([^"]*results[^"]*)"/.exec(req.command)?.[1]
    if (out.writes !== undefined && file) fs.writeFileSync(file, out.writes)
    return { exitCode: 0, timedOut: false, aborted: req.signal.aborted, tail: [], ...out }
  })
  const folders = {
    ensure: vi.fn(async (ws: { slug: string }) => {
      const root = path.join(tmp, ws.slug)
      const f = { root, repo: path.join(root, 'r'), temp: path.join(root, 'tmp'), results: path.join(root, 'results'), logs: path.join(root, 'logs'), created: true }
      for (const d of [f.repo, f.temp, f.results, f.logs]) fs.mkdirSync(d, { recursive: true })
      return f
    }),
    remove: vi.fn(async () => {})
  }
  const git = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
  const monitor = new BaseTestMonitor({
    repos: {
      workspaces: { get: async (id: string) => workspaces.find((w) => w.id === id) ?? null, list: async () => workspaces },
      baseTests: {
        add: async (r: Omit<BaseTestRun, 'id'>) => {
          const run = { ...r, id: `r${stored.length}` }
          stored.unshift(run)
          return run
        },
        list: async (id: string) => stored.filter((r) => r.workspaceId === id),
        latest: async (id: string) => stored.find((r) => r.workspaceId === id) ?? null
      }
    } as never,
    checker: { newestBase: vi.fn(async () => ({ ref: 'origin/main', sha, notice: null, fetchError: null })) },
    folders,
    git,
    commands: run,
    agentsWorking: () => working,
    now: () => clock.now(),
    emit: (e) => emitted.push(e),
    timer: clock,
    intervalMs: 5000,
    retryMs: 1000
  })
  return {
    monitor,
    clock,
    emitted,
    stored,
    run,
    calls,
    ran,
    folders,
    git,
    workspaces,
    moveBase: (s: string) => (sha = s),
    setWorking: (b: boolean) => (working = b)
  }
}

describe('BaseTestMonitor', () => {
  it('runs the commands in the baseline folder and records the exit code and the failing tests', async () => {
    const t = setup()
    await t.monitor.runNow('w1')

    expect(t.stored).toHaveLength(1)
    expect(t.stored[0]).toMatchObject({ workspaceId: 'w1', baseRef: 'origin/main', baseSha: 'aaa1111', trigger: 'manual', error: null })
    expect(t.stored[0]!.results[0]).toMatchObject({ name: 'Unit', exitCode: 1, timedOut: false, failures: ['t > bad'], tail: [], note: null })
    expect(t.calls[0]).toMatchObject({ cwd: path.join(tmp, 'w1', 'r'), tempDir: path.join(tmp, 'w1', 'tmp') })
    // <results> is the path of a file in the results folder, quoted.
    expect(t.calls[0]!.command).toBe(`run "${path.join(tmp, 'w1', 'results', '1.xml')}"`)
  })

  it('keeps the exit code and output tail for a plain command', async () => {
    const t = setup({
      commands: [{ name: 'Plain', command: 'npm test', format: 'plain' }],
      behaviour: async () => ({ exitCode: 3, tail: ['boom'] })
    })
    await t.monitor.runNow('w1')
    expect(t.stored[0]!.results[0]).toMatchObject({ exitCode: 3, failures: [], tail: ['boom'] })
    expect(t.stored[0]!.results[0]!.note).toContain('plain')
  })

  it('falls back to the exit code and tail when the results file is missing or unreadable', async () => {
    const missing = setup({ behaviour: async () => ({ exitCode: 1, tail: ['no file'] }) })
    await missing.monitor.runNow('w1')
    expect(missing.stored[0]!.results[0]).toMatchObject({ failures: [], tail: ['no file'] })
    expect(missing.stored[0]!.results[0]!.note).toContain('no results file')

    const bad = setup({ behaviour: async () => ({ exitCode: 1, writes: 'not xml', tail: ['x'] }) })
    await bad.monitor.runNow('w1')
    expect(bad.stored[0]!.results[0]!.failures).toEqual([])
    expect(bad.stored[0]!.results[0]!.note).toContain('JUnit')
  })

  it('does not read a results file left by an earlier run', async () => {
    let first = true
    const t = setup({
      behaviour: async () => {
        const out = first ? { exitCode: 1, writes: junit(['old']) } : { exitCode: 1, tail: ['t'] }
        first = false
        return out
      }
    })
    await t.monitor.runNow('w1')
    await t.monitor.runNow('w1')
    expect(t.stored[0]!.results[0]!.failures).toEqual([])
  })

  it('runs when the base moves, and not again for the same commit', async () => {
    const t = setup()
    t.monitor.start()
    await t.clock.advance(1000) // the first check
    await t.monitor.idle()
    expect(t.stored).toHaveLength(1)
    expect(t.stored[0]).toMatchObject({ trigger: 'base_moved', baseSha: 'aaa1111' })

    await t.clock.advance(5000)
    await t.monitor.idle()
    expect(t.stored).toHaveLength(1)

    t.moveBase('bbb2222')
    await t.clock.advance(5000)
    await t.monitor.idle()
    expect(t.stored.map((r) => r.baseSha)).toEqual(['bbb2222', 'aaa1111'])
    t.monitor.dispose()
  })

  it('does nothing for a workspace with no test commands', async () => {
    const t = setup({ commands: [] })
    t.monitor.start()
    await t.clock.advance(1000)
    await t.monitor.idle()
    expect(t.run).not.toHaveBeenCalled()
    t.monitor.dispose()
  })

  it('waits while an agent is working, says so, and runs once none is', async () => {
    const t = setup()
    t.setWorking(true)
    t.monitor.start()
    await t.clock.advance(1000)
    await t.monitor.idle()
    expect(t.run).not.toHaveBeenCalled()
    expect((await t.monitor.viewOf('w1')).waitingForAgents).toBe(true)
    expect(t.emitted).toContainEqual({ type: 'baseTests.changed', workspaceId: 'w1' })

    await t.clock.advance(1000)
    await t.monitor.idle()
    expect(t.run).not.toHaveBeenCalled()

    t.setWorking(false)
    await t.clock.advance(1000)
    await t.monitor.idle()
    expect(t.stored).toHaveLength(1)
    expect((await t.monitor.viewOf('w1')).waitingForAgents).toBe(false)
    t.monitor.dispose()
  })

  it('runs on demand whatever the agents are doing', async () => {
    const t = setup()
    t.setWorking(true)
    await t.monitor.runNow('w1')
    expect(t.stored[0]).toMatchObject({ trigger: 'manual' })
  })

  it('runs one at a time across workspaces, and a second request for the same workspace is the first', async () => {
    let active = 0
    let most = 0
    const gates: (() => void)[] = []
    const t = setup({
      workspaces: [
        { id: 'w1', slug: 'w1' },
        { id: 'w2', slug: 'w2' }
      ],
      behaviour: async () => {
        active += 1
        most = Math.max(most, active)
        await new Promise<void>((resolve) => gates.push(resolve))
        active -= 1
        return { exitCode: 0, writes: junit([]) }
      }
    })
    const a = t.monitor.runNow('w1')
    const again = t.monitor.runNow('w1')
    const b = t.monitor.runNow('w2')
    await eventually(() => expect(gates).toHaveLength(1))
    expect((await t.monitor.viewOf('w1')).running).toMatchObject({ baseSha: 'aaa1111', command: 'Unit' })
    expect((await t.monitor.viewOf('w2')).running).toBeNull()
    gates.shift()!()
    await eventually(() => expect(gates).toHaveLength(1))
    gates.shift()!()
    await Promise.all([a, again, b])
    expect(most).toBe(1)
    expect(t.stored.map((r) => r.workspaceId)).toEqual(['w2', 'w1'])
  })

  it('records a run that could not get as far as the commands, with the reason', async () => {
    const t = setup({ workspaces: [{ id: 'w1', slug: 'w1', setupCommand: 'npm ci' }], behaviour: async () => ({ exitCode: 1, tail: ['ERR!', 'bad'] }) })
    await t.monitor.runNow('w1')
    expect(t.stored[0]!.error).toContain('setup command')
    expect(t.stored[0]!.error).toContain('exited with code 1')
    expect(t.stored[0]!.results).toEqual([])
    expect(t.ran).toEqual(['npm ci'])
  })

  it('runs the setup command for a new folder, and again only when the lockfiles changed', async () => {
    const t = setup({ workspaces: [{ id: 'w1', slug: 'w1', setupCommand: 'npm ci' }], behaviour: async () => ({ exitCode: 0, writes: junit([]) }) })
    await t.monitor.runNow('w1')
    expect(t.ran.filter((c) => c === 'npm ci')).toHaveLength(1)

    // The same folder, the lockfiles untouched (git diff --quiet exits 0).
    t.folders.ensure.mockImplementationOnce(async (ws: { slug: string }) => ({
      root: path.join(tmp, ws.slug),
      repo: path.join(tmp, ws.slug, 'r'),
      temp: path.join(tmp, ws.slug, 'tmp'),
      results: path.join(tmp, ws.slug, 'results'),
      logs: path.join(tmp, ws.slug, 'logs'),
      created: false
    }))
    t.moveBase('bbb2222')
    await t.monitor.runNow('w1')
    expect(t.ran.filter((c) => c === 'npm ci')).toHaveLength(1)

    // A lockfile differs (exit code 1).
    t.folders.ensure.mockImplementationOnce(async (ws: { slug: string }) => ({
      root: path.join(tmp, ws.slug),
      repo: path.join(tmp, ws.slug, 'r'),
      temp: path.join(tmp, ws.slug, 'tmp'),
      results: path.join(tmp, ws.slug, 'results'),
      logs: path.join(tmp, ws.slug, 'logs'),
      created: false
    }))
    t.git.mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' })
    t.moveBase('ccc3333')
    await t.monitor.runNow('w1')
    expect(t.ran.filter((c) => c === 'npm ci')).toHaveLength(2)
  })

  it('records nothing when it is disposed during a run, and ends the command through the signal', async () => {
    let signal: AbortSignal | undefined
    const t = setup({
      behaviour: async (req) => {
        signal = req.signal
        await new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve()))
        return {}
      }
    })
    const done = t.monitor.runNow('w1')
    await eventually(() => expect(signal).toBeDefined())
    t.monitor.dispose()
    await done
    expect(signal!.aborted).toBe(true)
    expect(t.stored).toEqual([])
    expect((await t.monitor.viewOf('w1')).running).toBeNull()
  })

  it('forgets a workspace: ends its run and removes its folder', async () => {
    const t = setup()
    await t.monitor.forget(t.workspaces[0]!)
    expect(t.folders.remove).toHaveBeenCalledWith(t.workspaces[0])
  })

  it('describes the last run in its view and summary', async () => {
    const t = setup()
    expect(await t.monitor.summaryOf('w1')).toBeNull()
    await t.monitor.runNow('w1')
    const view = await t.monitor.viewOf('w1')
    expect(view.runs).toBe(1)
    expect(view.results[0]!.failures).toEqual(['t > bad'])
    expect(view.summary!.knownFailures.map((k) => k.test)).toEqual(['t > bad'])
    expect(await t.monitor.summaryOf('w1')).toEqual(view.summary)
  })
})
