import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../../shared/domain'
import type { ThreadEvent } from '../../shared/events'
import { runGit } from '../git/git'
import { WorktreeManager } from '../git/worktrees'
import { resolveHome, type HomePaths } from '../home'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import type { SetupCommandRequest, SetupCommandResult, SetupCommandRunner } from '../setup/setupCommand'
import { createRepos, type Repos } from '../store'
import { FIXED_NOW, implementerOnly, openTestDb } from '../store/testDb'
import { TicketRunner } from './ticketRunner'
import { eventually } from '../testWait'

let tmp: string
let repoPath: string
let closeDb: () => void
let repos: Repos
let worktrees: WorktreeManager
let paths: HomePaths
let workspaceId: string
let runners: TicketRunner[]
let tickets: Ticket[]
let setup: FakeSetup

/** vi.waitFor with room for a busy machine. */
function waitFor<T>(fn: () => T | Promise<T>): Promise<T> {
  return eventually(fn, { timeout: 10_000 })
}

const working: FakeStep[] = [{ emit: { kind: 'session', sessionId: 's1' } }, { waitForSend: true }]

const OK: SetupCommandResult = { exitCode: 0, timedOut: false, aborted: false, tail: ['added 120 packages'] }
const FAILED: SetupCommandResult = { exitCode: 1, timedOut: false, aborted: false, tail: ['npm ERR! network'] }
const TIMED_OUT: SetupCommandResult = { exitCode: null, timedOut: true, aborted: false, tail: ['still installing'] }

/** A setup command runner that records its calls and answers from a plan: a result, or 'hang' until released or aborted. */
class FakeSetup {
  readonly calls: SetupCommandRequest[] = []
  /** How many agents had been started when each call began. */
  readonly agentsStarted: number[] = []
  private readonly plan: Array<SetupCommandResult | 'hang'> = []
  private readonly waiting: Array<(r: SetupCommandResult) => void> = []

  constructor(private readonly runtime: () => FakeRuntime | null) {}

  /** The next calls, one result each; later calls succeed. */
  then(...results: Array<SetupCommandResult | 'hang'>): this {
    this.plan.push(...results)
    return this
  }

  /** Lets the oldest hanging call finish with `result`. */
  release(result: SetupCommandResult = OK): void {
    this.waiting.shift()?.(result)
  }

  readonly run: SetupCommandRunner = (req) => {
    this.calls.push(req)
    this.agentsStarted.push(this.runtime()?.specs.length ?? 0)
    const next = this.plan.shift() ?? OK
    if (next !== 'hang') return Promise.resolve(next)
    return new Promise((resolve) => {
      const done = (r: SetupCommandResult): void => resolve(r)
      this.waiting.push(done)
      req.signal.addEventListener('abort', () => resolve({ exitCode: null, timedOut: false, aborted: true, tail: [] }), { once: true })
    })
  }
}

async function git(args: string[]): Promise<void> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], repoPath)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}

let lastRuntime: FakeRuntime | null = null

function makeRunner(runtime: FakeRuntime, withSetup = true): TicketRunner {
  lastRuntime = runtime
  const runner = new TicketRunner({
    repos,
    worktrees,
    runtime,
    now: () => FIXED_NOW,
    emit: () => {},
    ...(withSetup ? { setup: setup.run } : {})
  })
  runners.push(runner)
  return runner
}

async function newTicket(title: string): Promise<Ticket> {
  const t = await repos.tickets.create({ workspaceId, title, intent: 'x', spec: '', criteria: [], labels: [], column: 'ready' })
  tickets.push(t)
  return t
}

async function thread(t: Ticket): Promise<ThreadEvent[]> {
  const run = await repos.runs.latest(t.id)
  return run ? (await repos.runs.events(run.id)).map((e) => e.event) : []
}

async function setupEntries(t: Ticket): Promise<Extract<ThreadEvent, { kind: 'setup' }>[]> {
  return (await thread(t)).filter((e): e is Extract<ThreadEvent, { kind: 'setup' }> => e.kind === 'setup')
}

async function theDecision(t: Ticket) {
  return waitFor(async () => {
    const [d] = await repos.decisions.pending(t.id)
    expect(d).toBeDefined()
    return d!
  })
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-setup-'))
  repoPath = path.join(tmp, 'repo')
  await fs.mkdir(repoPath)
  await git(['init', '-b', 'main'])
  await fs.writeFile(path.join(repoPath, 'README.md'), 'hello\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'initial'])
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  const testDb = await openTestDb()
  closeDb = testDb.cleanup
  repos = createRepos(testDb.db, () => FIXED_NOW)
  worktrees = new WorktreeManager(runGit, paths, repos.cleanups)
  const ws = await repos.workspaces.create(repoPath, 'main', 'repo', 'repo')
  workspaceId = ws.id
  await implementerOnly(repos.lineups, ws.id)
  await repos.workspaces.setSetupSettings(workspaceId, { command: 'npm ci', timeoutMinutes: 7 })
  runners = []
  tickets = []
  lastRuntime = null
  setup = new FakeSetup(() => lastRuntime)
})

afterEach(async () => {
  for (const runner of runners) for (const t of tickets) await runner.stop(t.id).catch(() => {})
  closeDb()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
})

vi.setConfig({ testTimeout: 30_000 })

describe('the setup command', () => {
  it('runs in a new ticket folder before the first role starts, with the scratch folder as TEMP', async () => {
    const runtime = new FakeRuntime(working)
    const runner = makeRunner(runtime)
    const t = await newTicket('A')
    await runner.start(t.id)

    const wt = (await repos.tickets.get(t.id)).worktreePath!
    expect(setup.calls).toHaveLength(1)
    expect(setup.agentsStarted).toEqual([0])
    expect(setup.calls[0]).toMatchObject({ command: 'npm ci', cwd: wt, tempDir: path.join(paths.scratch, path.relative(paths.worktrees, wt)) })
    expect(runtime.specs).toHaveLength(1)
    expect((await repos.tickets.get(t.id)).setup).toMatchObject({ state: 'succeeded', command: 'npm ci', exitCode: 0 })
  })

  it('puts the last 50 lines, the exit code, the duration and the log path in the thread', async () => {
    const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`)
    setup.then({ exitCode: 0, timedOut: false, aborted: false, tail: lines.slice(-50) })
    const runner = makeRunner(new FakeRuntime(working))
    const t = await newTicket('A')
    await runner.start(t.id)

    const [entry] = await setupEntries(t)
    expect(entry).toMatchObject({ command: 'npm ci', outcome: 'succeeded', exitCode: 0, durationMs: 0 })
    expect(entry!.tail).toHaveLength(50)
    expect(entry!.tail.at(-1)).toBe('line 120')
    expect(entry!.log).toBe(setup.calls[0]!.logPath)
    expect(path.dirname(entry!.log)).toBe(setup.calls[0]!.tempDir)
    // It is the first thing in the run's thread, before anything the agent does.
    expect((await thread(t))[0]!.kind).toBe('setup')
  })

  it('does nothing when the workspace has no command', async () => {
    await repos.workspaces.setSetupSettings(workspaceId, { command: '' })
    const runtime = new FakeRuntime(working)
    const t = await newTicket('A')
    await makeRunner(runtime).start(t.id)
    expect(setup.calls).toHaveLength(0)
    expect(runtime.specs).toHaveLength(1)
    expect((await repos.tickets.get(t.id)).setup).toBeNull()
  })

  it('does not run again on Start again', async () => {
    const runner = makeRunner(new FakeRuntime(working))
    const t = await newTicket('A')
    await runner.start(t.id)
    await runner.stop(t.id)
    await runner.start(t.id)
    expect(setup.calls).toHaveLength(1)
  })

  it('does not run in a folder that already existed', async () => {
    const t = await newTicket('A')
    const ws = (await repos.workspaces.get(workspaceId))!
    const made = await worktrees.ensure(ws, t)
    await repos.tickets.setWorktree(t.id, made.branch, made.path)
    const runtime = new FakeRuntime(working)
    await makeRunner(runtime).start(t.id)
    expect(setup.calls).toHaveLength(0)
    expect(runtime.specs).toHaveLength(1)
  })

  it('tells the role it ran and succeeded', async () => {
    const runtime = new FakeRuntime(working)
    const t = await newTicket('A')
    await makeRunner(runtime).start(t.id)
    expect(runtime.specs[0]!.appendSystemPrompt).toContain("Mainbus ran the workspace's setup command")
    expect(runtime.specs[0]!.appendSystemPrompt).toContain('it succeeded. Don\'t run it again.')
  })
})

describe('when the setup command fails', () => {
  it('times out after the workspace minutes and asks what to do, without starting the role', async () => {
    setup.then(TIMED_OUT)
    const runtime = new FakeRuntime(working)
    const t = await newTicket('A')
    await makeRunner(runtime).start(t.id)

    expect(setup.calls[0]!.timeoutMs).toBe(7 * 60_000)
    expect(runtime.specs).toHaveLength(0)
    expect(await setupEntries(t)).toMatchObject([{ outcome: 'timed_out', exitCode: null }])
    const d = await theDecision(t)
    expect(d.options).toEqual(['Retry', 'Start without setup', 'Stop'])
    expect(d.question).toContain('timed out after 7 minutes')
    expect((await repos.tickets.get(t.id)).setup).toMatchObject({ state: 'failed', timedOut: true })
  })

  it('Retry runs it again and then starts the role with its first message', async () => {
    setup.then(FAILED)
    const runtime = new FakeRuntime(working)
    const runner = makeRunner(runtime)
    const t = await newTicket('A')
    await runner.start(t.id)
    const d = await theDecision(t)
    expect(await setupEntries(t)).toMatchObject([{ outcome: 'failed', exitCode: 1 }])

    await runner.answer(d.id, { kind: 'option', index: 0 }, 'thread')

    expect(setup.calls).toHaveLength(2)
    expect(await setupEntries(t)).toMatchObject([{ outcome: 'failed' }, { outcome: 'succeeded' }])
    expect(runtime.specs).toHaveLength(1)
    expect(runtime.specs[0]!.prompt).toBe(`Start work on #${t.number} A.`)
    expect(runtime.specs[0]!.appendSystemPrompt).toContain('it succeeded')
  })

  it('Start without setup starts the role and tells it setup failed, with the end of the output', async () => {
    setup.then(FAILED)
    const runtime = new FakeRuntime(working)
    const runner = makeRunner(runtime)
    const t = await newTicket('A')
    await runner.start(t.id)
    const d = await theDecision(t)

    await runner.answer(d.id, { kind: 'option', index: 1 }, 'thread')

    expect(setup.calls).toHaveLength(1)
    expect(runtime.specs).toHaveLength(1)
    expect(runtime.specs[0]!.prompt).toBe(`Start work on #${t.number} A.`)
    expect(runtime.specs[0]!.appendSystemPrompt).toContain('it failed (exited with code 1)')
    expect(runtime.specs[0]!.appendSystemPrompt).toContain('npm ERR! network')
    expect((await repos.tickets.get(t.id)).setup).toMatchObject({ state: 'skipped' })
  })

  it('Stop ends the run, and the next start runs setup again', async () => {
    setup.then(FAILED)
    const runtime = new FakeRuntime(working)
    const runner = makeRunner(runtime)
    const t = await newTicket('A')
    await runner.start(t.id)
    const d = await theDecision(t)

    await runner.answer(d.id, { kind: 'option', index: 2 }, 'thread')

    expect(await repos.runs.latest(t.id)).toMatchObject({ endReason: 'stopped' })
    expect(await runner.stateOf(t.id)).toMatchObject({ column: 'ready', agentStatus: null })
    expect(runtime.specs).toHaveLength(0)

    await runner.start(t.id)
    expect(setup.calls).toHaveLength(2)
    expect(runtime.specs).toHaveLength(1)
  })

  it('refuses a message while the decision is open', async () => {
    setup.then(FAILED)
    const runner = makeRunner(new FakeRuntime(working))
    const t = await newTicket('A')
    await runner.start(t.id)
    await theDecision(t)

    await expect(runner.send(t.id, 'just go on')).rejects.toThrow(/setup command failed/)
    await expect(runner.continue(t.id)).rejects.toThrow(/setup command failed/)
    expect(await repos.decisions.pending(t.id)).toHaveLength(1)
  })
})

describe('Run setup again', () => {
  it('runs the command in the folder of an ended run and records it as again', async () => {
    const runner = makeRunner(new FakeRuntime(working))
    const t = await newTicket('A')
    await runner.start(t.id)
    await runner.stop(t.id)

    await runner.runSetupAgain(t.id)

    expect(setup.calls).toHaveLength(2)
    expect(await setupEntries(t)).toMatchObject([{ outcome: 'succeeded' }, { outcome: 'succeeded', again: true }])
  })

  it('leaves a failure as a failed state without a decision, and the next start retries it', async () => {
    const runtime = new FakeRuntime(working)
    const runner = makeRunner(runtime)
    const t = await newTicket('A')
    await runner.start(t.id)
    await runner.stop(t.id)
    setup.then(FAILED)

    await runner.runSetupAgain(t.id)

    expect(await repos.decisions.pending(t.id)).toHaveLength(0)
    expect((await repos.tickets.get(t.id)).setup).toMatchObject({ state: 'failed' })
    await runner.start(t.id)
    expect(setup.calls).toHaveLength(3)
  })

  it('is refused while a role is working, with no command, and for a Done ticket', async () => {
    const runner = makeRunner(new FakeRuntime(working))
    const t = await newTicket('A')
    await runner.start(t.id)
    await expect(runner.runSetupAgain(t.id)).rejects.toThrow(/agent is working/)
    await runner.stop(t.id)

    await repos.workspaces.setSetupSettings(workspaceId, { command: '' })
    await expect(runner.runSetupAgain(t.id)).rejects.toThrow(/no setup command/)
    await repos.workspaces.setSetupSettings(workspaceId, { command: 'npm ci' })

    await repos.tickets.setManualColumn(t.id, 'done')
    await expect(runner.runSetupAgain(t.id)).rejects.toThrow(/Done/)
    expect(setup.calls).toHaveLength(1)
  })
})

describe('while setup runs', () => {
  it('shows Setting up, and holds no agent slot', async () => {
    await repos.settings.setMaxAgents(1)
    setup.then('hang')
    const runtime = new FakeRuntime(working)
    const runner = makeRunner(runtime)
    const [a, b] = [await newTicket('A'), await newTicket('B')]

    const starting = runner.start(a.id)
    await waitFor(() => expect(setup.calls).toHaveLength(1))
    expect(await runner.stateOf(a.id)).toMatchObject({ column: 'in_progress', agentStatus: 'working', settingUp: true })
    expect(runner.isLaunching(a.id)).toBe(true)

    // B takes the only slot while A is still setting up.
    await runner.start(b.id)
    await waitFor(async () => expect((await runner.stateOf(b.id)).agentStatus).toBe('working'))

    setup.release()
    await starting
    expect(await runner.stateOf(a.id)).toMatchObject({ agentStatus: 'queued', queuePosition: 1 })
    expect((await runner.stateOf(a.id)).settingUp).toBeUndefined()
    expect(runtime.specs).toHaveLength(1)
  })

  it('a stop ends the setup command at once and the next start runs it again', async () => {
    setup.then('hang')
    const runtime = new FakeRuntime(working)
    const runner = makeRunner(runtime)
    const t = await newTicket('A')

    const starting = runner.start(t.id)
    await waitFor(() => expect(setup.calls).toHaveLength(1))
    const stopping = runner.stop(t.id)
    expect(setup.calls[0]!.signal.aborted).toBe(true)
    await Promise.all([starting, stopping])

    expect(await repos.runs.latest(t.id)).toMatchObject({ endReason: 'stopped' })
    expect(await setupEntries(t)).toMatchObject([{ outcome: 'stopped' }])
    expect((await repos.tickets.get(t.id)).setup).toMatchObject({ state: 'pending' })
    expect(runtime.specs).toHaveLength(0)

    await runner.start(t.id)
    expect(setup.calls).toHaveLength(2)
    expect(runtime.specs).toHaveLength(1)
  })

  it('quitting ends the setup command, recovery leaves the run paused, and Continue runs setup again', async () => {
    setup.then('hang')
    const before = makeRunner(new FakeRuntime(working))
    const t = await newTicket('A')
    const starting = before.start(t.id)
    await waitFor(() => expect(setup.calls).toHaveLength(1))

    await before.shutdown()
    await starting
    expect(setup.calls[0]!.signal.aborted).toBe(true)
    expect(await repos.runs.latest(t.id)).toMatchObject({ endReason: null })

    const runtime = new FakeRuntime(working)
    const runner = makeRunner(runtime)
    await runner.markAllNotAlive()
    await runner.recover({ resume: true })
    await runner.queueSettled()
    expect(runtime.specs).toHaveLength(0)
    expect(await runner.stateOf(t.id)).toMatchObject({ agentStatus: 'paused', canContinue: true })

    await runner.continue(t.id)
    expect(setup.calls).toHaveLength(2)
    expect(runtime.specs).toHaveLength(1)
    expect(runtime.specs[0]!.prompt).toBe(`Start work on #${t.number} A.`)
  })
})
