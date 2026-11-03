import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent } from '../shared/api'
import { openDb } from './db/open'
import { runCommand } from './git/command'
import { FakeGh } from './git/fakeGh'
import { runGit } from './git/git'
import { resolveHome, type HomePaths } from './home'
import { createEngine, SetupRequiredError, type Engine } from './index'
import { FakeRuntime, scriptFromFile } from './runtime/fakeRuntime'
import type { ExecFn } from './runtime/resolveClaude'
import type { AgentRuntime } from './runtime/types'
import { ProcessSweeper } from './processes/sweep'
import { createRepos } from './store'

const migrationsDir = path.join(import.meta.dirname, 'db', 'migrations')

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]

async function git(args: string[], cwd: string): Promise<void> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}

async function makeRepo(name: string): Promise<string> {
  const dir = path.join(tmp, name)
  await fs.mkdir(dir)
  await git(['init', '-b', 'main'], dir)
  await fs.writeFile(path.join(dir, 'README.md'), 'hello\n')
  await git(['add', '.'], dir)
  await git(['commit', '-m', 'initial'], dir)
  return dir
}

const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

async function makeEngine(runtime: AgentRuntime | null): Promise<Engine> {
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec })
  engines.push(engine)
  return engine
}

const newTicket = {
  title: 'Rate-limit login',
  intent: 'Slow down brute force',
  spec: '',
  criteria: [],
  labels: [],
  column: 'ready' as const
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-engine-'))
  repoPath = await makeRepo('repo')
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  engines = []
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('createEngine', () => {
  it('invoke routes to the runner and repositories', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    expect(await engine.invoke('workspace.get')).toBeNull()

    const ws = await engine.invoke('workspace.open', repoPath)
    expect(ws).toMatchObject({ name: 'repo', slug: 'repo', baseBranch: 'main', repoPath })
    expect(await engine.invoke('workspace.get')).toEqual(ws)

    const created = await engine.invoke('ticket.create', newTicket)
    expect(created.workspaceId).toBe(ws.id)

    const board = await engine.invoke('board.get')
    expect(board.tickets).toHaveLength(1)
    expect(board.tickets[0]).toMatchObject({ id: created.id, title: 'Rate-limit login', state: { column: 'ready' } })

    const updated = await engine.invoke('ticket.update', created.id, { title: 'Throttle login' })
    expect(updated.title).toBe('Throttle login')
    const appended = await engine.invoke('ticket.appendIntent', created.id, 'Also lock out after 10 tries')
    expect(appended.intent.map((i) => i.text)).toEqual(['Slow down brute force', 'Also lock out after 10 tries'])

    expect(await engine.invoke('ticket.move', created.id, 'backlog')).toBe('moved')
    expect((await engine.invoke('board.get')).tickets[0]!.state.column).toBe('backlog')
    expect(await engine.invoke('ticket.move', created.id, 'done')).toBe('moved')
    expect((await engine.invoke('board.get')).tickets[0]!.state.column).toBe('done')

    const lineup = await engine.invoke('lineup.get')
    expect(lineup.map((r) => r.name)).toEqual(['Planner', 'Implementer', 'Reviewer'])
    const saved = await engine.invoke('lineup.save', [{ ...lineup[1]!, instructions: 'Be careful.' }])
    expect(saved).toMatchObject([{ id: lineup[1]!.id, name: 'Implementer', instructions: 'Be careful.', position: 1 }])
    await expect(engine.invoke('lineup.save', [])).rejects.toThrow('A lineup needs at least one role.')
    expect(await engine.invoke('allowRules.list')).toEqual([])
  })

  it('starting an agent runs it in the ticket worktree', async () => {
    const runtime = new FakeRuntime([{ waitForSend: true }])
    const engine = await makeEngine(runtime)
    await engine.invoke('workspace.open', repoPath)
    const t = await engine.invoke('ticket.create', newTicket)

    await engine.invoke('agent.start', t.id)

    expect(runtime.specs).toHaveLength(1)
    expect(runtime.specs[0]!.cwd.startsWith(paths.worktrees)).toBe(true)
    expect((await engine.invoke('board.get')).tickets[0]!.state.column).toBe('in_progress')
  })

  it('thread.get returns the latest run with its decisions, and decision.answer answers them', async () => {
    const engine = await makeEngine(
      new FakeRuntime([{ callTool: 'askUser', args: { question: 'Which?', options: ['A', 'B'] } }])
    )
    await engine.invoke('workspace.open', repoPath)
    const t = await engine.invoke('ticket.create', newTicket)
    await engine.invoke('agent.start', t.id)

    await vi.waitFor(async () => expect((await engine.invoke('thread.get', t.id)).decisions).toHaveLength(1))
    const { events, decisions } = await engine.invoke('thread.get', t.id)
    expect(decisions[0]).toMatchObject({ question: 'Which?', status: 'pending' })
    expect(events.some((e) => e.event.kind === 'decision')).toBe(true)

    await engine.invoke('decision.answer', decisions[0]!.id, { kind: 'option', index: 1 }, 'thread')
    expect((await engine.invoke('thread.get', t.id)).decisions[0]!.status).toBe('answered')
  })

  it('thread.get returns the events of every run of the ticket, oldest run first, and all its decisions', async () => {
    const engine = await makeEngine(
      new FakeRuntime([
        { emit: { kind: 'message', text: 'attempt' } },
        { callTool: 'askUser', args: { question: 'Which?', options: ['A', 'B'] } },
        { waitForSend: true }
      ])
    )
    await engine.invoke('workspace.open', repoPath)
    const t = await engine.invoke('ticket.create', newTicket)

    await engine.invoke('agent.start', t.id)
    await vi.waitFor(async () => expect((await engine.invoke('thread.get', t.id)).decisions).toHaveLength(1))
    await engine.invoke('agent.stop', t.id)
    await engine.invoke('agent.start', t.id)
    await vi.waitFor(async () => expect((await engine.invoke('thread.get', t.id)).decisions).toHaveLength(2))

    const { events, decisions } = await engine.invoke('thread.get', t.id)
    const runIds = [...new Set(events.map((e) => e.runId))]
    expect(runIds).toHaveLength(2)
    const [first, second] = runIds
    expect(events.map((e) => [e.runId === first ? 1 : 2, e.event.kind])).toEqual([
      [1, 'message'],
      [1, 'decision'],
      [1, 'stopped'],
      [2, 'message'],
      [2, 'decision']
    ])
    expect(events.filter((e) => e.runId === second).map((e) => e.seq)).toEqual([1, 2])
    expect(decisions.map((d) => [d.agentRunId === first ? 1 : 2, d.status])).toEqual([
      [1, 'expired'],
      [2, 'pending']
    ])
  })

  it('thread.get is empty for a ticket that never ran', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    await engine.invoke('workspace.open', repoPath)
    const t = await engine.invoke('ticket.create', newTicket)
    expect(await engine.invoke('thread.get', t.id)).toEqual({ events: [], decisions: [], runs: [] })
  })

  describe('the lineup strip', () => {
    const planThenWait = () =>
      new FakeRuntime(
        scriptFromFile({
          Planner: [{ callTool: 'handoff', args: { summary: 'Planned', notesForNext: '' } }, { emit: { kind: 'turn_end', ok: true } }],
          '*': [{ waitForSend: true }]
        })
      )
    const stripOf = async (engine: Engine) =>
      (await engine.invoke('board.get')).tickets[0]!.lineup.map((r) => [r.name, r.status, r.active])

    it('board.get shows the workspace lineup before the first run, then the run’s roles as they work', async () => {
      const engine = await makeEngine(planThenWait())
      await engine.invoke('workspace.open', repoPath)
      const t = await engine.invoke('ticket.create', newTicket)
      expect(await stripOf(engine)).toEqual([
        ['Planner', 'not_started', false],
        ['Implementer', 'not_started', false],
        ['Reviewer', 'not_started', false]
      ])

      await engine.invoke('agent.start', t.id)
      await vi.waitFor(async () =>
        expect(await stripOf(engine)).toEqual([
          ['Planner', 'handed_off', false],
          ['Implementer', 'working', true],
          ['Reviewer', 'not_started', false]
        ])
      )
      // The card's phase follows the active role.
      expect((await engine.invoke('board.get')).tickets[0]!.state.phase).toBe('implementing')

      // thread.get names each event's run: its role and ticket run.
      const { events, runs } = await engine.invoke('thread.get', t.id)
      expect(runs.map((r) => r.role)).toEqual(['Planner', 'Implementer'])
      expect(new Set(runs.map((r) => r.ticketRunId)).size).toBe(1)
      expect(events.every((e) => runs.some((r) => r.id === e.runId))).toBe(true)
    })

    it('shows only the roles ticked at start', async () => {
      const engine = await makeEngine(planThenWait())
      await engine.invoke('workspace.open', repoPath)
      const t = await engine.invoke('ticket.create', newTicket)
      const lineup = await engine.invoke('lineup.get')
      await engine.invoke('agent.start', t.id, { roleIds: [lineup[1]!.id, lineup[2]!.id] })
      await vi.waitFor(async () =>
        expect(await stripOf(engine)).toEqual([
          ['Implementer', 'working', true],
          ['Reviewer', 'not_started', false]
        ])
      )
    })

    it('a Done ticket keeps its last run’s strip', async () => {
      const engine = await makeEngine(planThenWait())
      await engine.invoke('workspace.open', repoPath)
      const t = await engine.invoke('ticket.create', newTicket)
      await engine.invoke('agent.start', t.id)
      await vi.waitFor(async () => expect((await stripOf(engine))[1]).toEqual(['Implementer', 'working', true]))
      await engine.invoke('agent.stop', t.id)
      expect(await engine.invoke('ticket.move', t.id, 'done')).toBe('moved')
      expect(await stripOf(engine)).toEqual([
        ['Planner', 'handed_off', false],
        ['Implementer', 'stopped', false],
        ['Reviewer', 'not_started', false]
      ])
    })

    it('lineup.save announces a board change, so a strip before the first run follows the lineup', async () => {
      const engine = await makeEngine(new FakeRuntime([]))
      await engine.invoke('workspace.open', repoPath)
      await engine.invoke('ticket.create', newTicket)
      const events: EngineEvent[] = []
      engine.on((e) => events.push(e))
      const lineup = await engine.invoke('lineup.get')
      await engine.invoke('lineup.save', [lineup[1]!, { ...lineup[2]!, name: 'Checker' }])
      expect(events.some((e) => e.type === 'board.changed')).toBe(true)
      expect(await stripOf(engine)).toEqual([
        ['Implementer', 'not_started', false],
        ['Checker', 'not_started', false]
      ])
    })
  })

  it('agent commands throw SetupRequiredError when runtime is null', async () => {
    const engine = await makeEngine(null)
    await engine.invoke('workspace.open', repoPath)
    const t = await engine.invoke('ticket.create', newTicket)

    for (const attempt of [
      () => engine.invoke('agent.start', t.id),
      () => engine.invoke('agent.send', t.id, 'hi'),
      () => engine.invoke('agent.continue', t.id),
      () => engine.invoke('decision.answer', 'whatever', { kind: 'option', index: 0 }, 'thread')
    ]) {
      const err = await attempt().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SetupRequiredError)
      expect((err as Error).name).toBe('SetupRequiredError')
    }
    // Nothing was set up for the ticket: no worktree, still Ready.
    expect((await engine.invoke('board.get')).tickets[0]!.state.column).toBe('ready')
    await expect(fs.access(paths.worktrees)).rejects.toThrow()
  })

  it('engine events reach listeners until they unsubscribe', async () => {
    const engine = await makeEngine(new FakeRuntime([{ waitForSend: true }]))
    const seen: EngineEvent[] = []
    const off = engine.on((e) => seen.push(e))

    const ws = await engine.invoke('workspace.open', repoPath)
    const t = await engine.invoke('ticket.create', newTicket)
    expect(seen).toContainEqual({ type: 'board.changed', workspaceId: ws.id })

    seen.length = 0
    await engine.invoke('agent.start', t.id)
    expect(seen.some((e) => e.type === 'board.changed')).toBe(true)

    off()
    seen.length = 0
    await engine.invoke('ticket.update', t.id, { title: 'Renamed' })
    expect(seen).toEqual([])
  })

  it('a throwing listener does not break the others or the command', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    const seen: EngineEvent[] = []
    engine.on(() => {
      throw new Error('bad listener')
    })
    engine.on((e) => seen.push(e))
    await engine.invoke('workspace.open', repoPath)
    expect(seen.length).toBeGreaterThan(0)
  })

  it('rejects an unknown command', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    const loose = engine.invoke as (k: string, ...args: unknown[]) => Promise<unknown>
    await expect(loose('nope')).rejects.toThrow('Unknown command: nope')
    await expect(loose('toString')).rejects.toThrow('Unknown command: toString')
  })

  it('setup.check reports what resolveClaude finds', async () => {
    const engine = await makeEngine(null)
    expect(await engine.invoke('setup.check')).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('setup.check asks for a restart when claude is found but the engine started without a runtime', async () => {
    const found: ExecFn = async (file) => ({
      code: 0,
      stdout: file === 'where.exe' || file === 'which' ? 'C:/tools/claude.exe\n' : '2.1.314 (Claude Code)\n',
      stderr: ''
    })
    const without = await createEngine({ paths, migrationsDir, runtime: null, git: runGit, exec: found })
    engines.push(without)
    expect(await without.invoke('setup.check')).toEqual({
      ok: false,
      reason: 'restart_required',
      detail: 'Restart Mainbus to use Claude Code.'
    })
    await without.dispose()

    const withRuntime = await createEngine({ paths, migrationsDir, runtime: new FakeRuntime([]), git: runGit, exec: found })
    engines.push(withRuntime)
    expect(await withRuntime.invoke('setup.check')).toMatchObject({ ok: true })
  })
})

describe('workspace.open', () => {
  it('returns the existing workspace for the same path, and opens a different repo as another workspace', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    const first = await engine.invoke('workspace.open', repoPath)
    expect(await engine.invoke('workspace.open', repoPath)).toEqual(first)
    if (process.platform === 'win32') {
      expect(await engine.invoke('workspace.open', repoPath.toUpperCase())).toEqual(first)
    }

    const other = await engine.invoke('workspace.open', await makeRepo('other'))
    expect(other.id).not.toBe(first.id)
    expect((await engine.invoke('workspace.list')).map((w) => w.id)).toEqual([first.id, other.id])
  })

  it('fails clearly when the folder is not a git repository or does not exist', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    const plain = path.join(tmp, 'plain')
    await fs.mkdir(plain)
    await expect(engine.invoke('workspace.open', plain)).rejects.toThrow(/not a git repository/i)
    await expect(engine.invoke('workspace.open', path.join(tmp, 'missing'))).rejects.toThrow(/does not exist/i)
    expect(await engine.invoke('workspace.get')).toBeNull()
  })

  it('opens the repository root when given a subfolder', async () => {
    const sub = path.join(repoPath, 'src', 'deep')
    await fs.mkdir(sub, { recursive: true })
    const engine = await makeEngine(new FakeRuntime([]))
    const ws = await engine.invoke('workspace.open', sub)
    expect(ws.repoPath.toLowerCase()).toBe(repoPath.toLowerCase())
    expect(ws.name).toBe('repo')
    // The subfolder and the root are the same workspace.
    expect(await engine.invoke('workspace.open', repoPath)).toEqual(ws)
    expect(await engine.invoke('workspace.open', sub)).toEqual(ws)
  })

  it('fails clearly on a repository with no commits', async () => {
    const empty = path.join(tmp, 'empty')
    await fs.mkdir(empty)
    await git(['init', '-b', 'main'], empty)
    const engine = await makeEngine(new FakeRuntime([]))
    await expect(engine.invoke('workspace.open', empty)).rejects.toThrow('The repository has no commits yet.')
    expect(await engine.invoke('workspace.get')).toBeNull()
  })

  it('fails clearly on a detached HEAD', async () => {
    await git(['checkout', '--detach'], repoPath)
    const engine = await makeEngine(new FakeRuntime([]))
    await expect(engine.invoke('workspace.open', repoPath)).rejects.toThrow(/current branch/i)
  })

  it('uses the checked-out branch as the base branch', async () => {
    await git(['checkout', '-b', 'develop'], repoPath)
    const engine = await makeEngine(new FakeRuntime([]))
    expect((await engine.invoke('workspace.open', repoPath)).baseBranch).toBe('develop')
  })

  it('commands that need a workspace say so', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    await expect(engine.invoke('ticket.create', newTicket)).rejects.toThrow('Open a workspace first')
    await expect(engine.invoke('lineup.get')).rejects.toThrow('Open a workspace first')
    expect(await engine.invoke('board.get')).toEqual({ tickets: [] })
    expect(await engine.invoke('allowRules.list')).toEqual([])
  })
})

describe('ticket.move', () => {
  it('refuses to move a ticket that has an open run', async () => {
    const engine = await makeEngine(new FakeRuntime([{ waitForSend: true }]))
    await engine.invoke('workspace.open', repoPath)
    const t = await engine.invoke('ticket.create', newTicket)
    await engine.invoke('agent.start', t.id)

    await expect(engine.invoke('ticket.move', t.id, 'backlog')).rejects.toThrow(/stop/i)
    await expect(engine.invoke('ticket.move', t.id, 'ready')).rejects.toThrow(/stop/i)

    await engine.invoke('agent.stop', t.id)
    expect(await engine.invoke('ticket.move', t.id, 'backlog')).toBe('moved')
  })

  it('a move queued right behind agent.start sees the run that start creates', async () => {
    const engine = await makeEngine(new FakeRuntime([{ waitForSend: true }]))
    await engine.invoke('workspace.open', repoPath)
    const t = await engine.invoke('ticket.create', newTicket)

    const started = engine.invoke('agent.start', t.id)
    const moved = engine.invoke('ticket.move', t.id, 'backlog')

    await expect(moved).rejects.toThrow(/stop the agent/i)
    await started
    expect((await engine.invoke('board.get')).tickets[0]!.state.column).toBe('in_progress')
  })

  it('reports dirty and leaves the ticket in place when the worktree has uncommitted work', async () => {
    const engine = await makeEngine(new FakeRuntime([{ waitForSend: true }]))
    await engine.invoke('workspace.open', repoPath)
    const t = await engine.invoke('ticket.create', newTicket)
    await engine.invoke('agent.start', t.id)
    await engine.invoke('agent.stop', t.id)
    const { worktreePath } = (await engine.invoke('board.get')).tickets[0]!
    await fs.writeFile(path.join(worktreePath!, 'wip.txt'), 'unsaved\n')

    expect(await engine.invoke('ticket.move', t.id, 'done')).toBe('dirty')
    expect((await engine.invoke('board.get')).tickets[0]!.state.column).not.toBe('done')
  })
})

describe('lifecycle', () => {
  it('dispose stops live agents, leaves their runs resumable and closes the database', async () => {
    const runtime = new FakeRuntime([{ waitForSend: true }])
    const first = await makeEngine(runtime)
    await first.invoke('workspace.open', repoPath)
    const t = await first.invoke('ticket.create', newTicket)
    await first.invoke('agent.start', t.id)

    await first.dispose()
    await first.dispose() // harmless

    const second = await makeEngine(new FakeRuntime([]))
    const [card] = (await second.invoke('board.get')).tickets
    expect(card!.id).toBe(t.id)
    expect(card!.state.canContinue).toBe(true)
    const kinds = (await second.invoke('thread.get', t.id)).events.map((e) => e.event.kind)
    expect(kinds).toContain('process_exit')
    expect(kinds).not.toContain('stopped')
  })

  it('create finishes interrupted worktree removals', async () => {
    const first = await makeEngine(new FakeRuntime([{ waitForSend: true }]))
    await first.invoke('workspace.open', repoPath)
    const t = await first.invoke('ticket.create', newTicket)
    await first.invoke('agent.start', t.id)
    await first.invoke('agent.stop', t.id)
    const { worktreePath, branch } = (await first.invoke('board.get')).tickets[0]!
    await expect(fs.access(worktreePath!)).resolves.toBeUndefined()
    await first.dispose()

    // Record a removal that was decided but never carried out.
    const handle = await openDb(paths, migrationsDir)
    await createRepos(handle.db, () => new Date()).cleanups.add(t.id, repoPath, worktreePath!, branch!)
    handle.close()

    await makeEngine(new FakeRuntime([]))
    await expect(fs.access(worktreePath!)).rejects.toThrow()
  })
})

describe('agents.launcher', () => {
  it("adds why the intake pipe couldn't be opened, read when asked", async () => {
    const launcher = { kind: 'stable' as const, program: ['/x/mainbus.cmd'], env: {}, exists: true }
    let intakeError: string | null = null
    const engine = await createEngine({ paths, migrationsDir, runtime: null, git: runGit, exec, launcher, intakeError: () => intakeError })
    engines.push(engine)
    expect(await engine.invoke('agents.launcher')).toEqual(launcher)
    intakeError = "Mainbus couldn't open the pipe: EADDRINUSE"
    expect(await engine.invoke('agents.launcher')).toEqual({ ...launcher, intakeError })
  })
})

describe('pull requests', () => {
  it('are off for a new workspace; switched on, a handoff opens one, and Retry pushes again', { timeout: 60_000 }, async () => {
    const gh = new FakeGh()
    const runtime = new FakeRuntime([{ waitForSend: true }])
    const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec, commands: gh.runner(runCommand) })
    engines.push(engine)
    const origin = path.join(tmp, 'origin.git')
    await git(['init', '--bare', '-b', 'main', origin], tmp)
    await git(['remote', 'add', 'origin', origin], repoPath)

    expect((await engine.invoke('workspace.open', repoPath)).openPrOnReview).toBe(false)
    expect(await engine.invoke('github.check')).toEqual({ ok: true })
    gh.state = 'signed_out'
    expect(await engine.invoke('github.check')).toEqual({ ok: false, reason: expect.stringMatching(/not signed in/) })
    gh.state = 'ok'
    expect((await engine.invoke('workspace.setOpenPrOnReview', true)).openPrOnReview).toBe(true)
    expect((await engine.invoke('workspace.get'))?.openPrOnReview).toBe(true)

    const ticket = await engine.invoke('ticket.create', newTicket)
    await engine.invoke('agent.start', ticket.id)
    // Planner, Implementer and Reviewer hand off in turn; only the Reviewer's handoff pushes.
    for (const i of [0, 1, 2]) {
      const spec = await vi.waitFor(() => {
        expect(runtime.specs[i]).toBeDefined()
        return runtime.specs[i]!
      })
      expect(gh.calls.filter((c) => c[0] === 'pr')).toEqual([])
      expect((await engine.invoke('board.get')).tickets[0]?.state.column).toBe('in_progress')
      await spec.roleTools.handoff({ summary: 'Done', notesForNext: '' })
    }
    const pr = { url: 'https://github.com/example/repo/pull/1', number: 1 }
    await vi.waitFor(async () => expect((await engine.invoke('board.get')).tickets[0]).toMatchObject({ pr, prError: null }), {
      timeout: 20_000,
      interval: 50
    })

    await engine.invoke('ticket.openPr', ticket.id)
    expect(gh.prs).toHaveLength(1)
    expect((await engine.invoke('board.get')).tickets[0]).toMatchObject({ pr, state: { column: 'review' } })
  })
})

describe('createEngine: restart recovery', () => {
  it('shows the board before the sweep of leftover processes ends, then resumes the agent and restores unattended mode', async () => {
    const working = [
      { emit: { kind: 'session' as const, sessionId: 'sess-1' } },
      { emit: { kind: 'message' as const, text: 'on it' } },
      { waitForSend: true as const }
    ]
    const first = await makeEngine(new FakeRuntime(working))
    await first.invoke('workspace.open', repoPath)
    const created = await first.invoke('ticket.create', newTicket)
    await first.invoke('agent.start', created.id)
    await vi.waitFor(async () => expect((await first.invoke('thread.get', created.id)).events.some((e) => e.event.kind === 'message')).toBe(true))
    await first.invoke('unattended.set', true)
    await first.dispose()

    // A crash would have left the old process recorded.
    const handle = await openDb(paths, migrationsDir)
    const repos = createRepos(handle.db, () => new Date())
    const run = (await repos.runs.latest(created.id))!
    await repos.runs.setProcess(run.id, { pid: 4242, startedAt: 1 })
    handle.close()

    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const runtime = new FakeRuntime(working)
    const engine = await createEngine({
      paths,
      migrationsDir,
      runtime,
      git: runGit,
      exec,
      processes: new ProcessSweeper(
        async () => {
          await gate
          return []
        },
        async () => {}
      )
    })
    engines.push(engine)

    // The sweep is still waiting: the board answers from the DB, and nothing has started.
    expect((await engine.invoke('board.get')).tickets).toHaveLength(1)
    expect(runtime.specs).toHaveLength(0)
    expect((await engine.invoke('unattended.get')).on).toBe(false)

    release()
    await vi.waitFor(() => expect(runtime.specs).toHaveLength(1))
    expect(runtime.specs[0]).toMatchObject({ resumeSessionId: 'sess-1', prompt: 'Mainbus restarted; continue where you left off.' })
    await vi.waitFor(async () => expect((await engine.invoke('unattended.get')).on).toBe(true))
  })
})
