import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent } from '../shared/api'
import { openDb } from './db/open'
import { runGit } from './git/git'
import { resolveHome, type HomePaths } from './home'
import { createEngine, SetupRequiredError, type Engine } from './index'
import { FakeRuntime } from './runtime/fakeRuntime'
import type { ExecFn } from './runtime/resolveClaude'
import type { AgentRuntime } from './runtime/types'
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

    expect((await engine.invoke('role.get')).name).toBe('Implementer')
    const role = await engine.invoke('role.update', { instructions: 'Be careful.' })
    expect(role.instructions).toBe('Be careful.')
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

    await engine.invoke('decision.answer', decisions[0]!.id, { kind: 'option', index: 1 })
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
    expect(await engine.invoke('thread.get', t.id)).toEqual({ events: [], decisions: [] })
  })

  it('agent commands throw SetupRequiredError when runtime is null', async () => {
    const engine = await makeEngine(null)
    await engine.invoke('workspace.open', repoPath)
    const t = await engine.invoke('ticket.create', newTicket)

    for (const attempt of [
      () => engine.invoke('agent.start', t.id),
      () => engine.invoke('agent.send', t.id, 'hi'),
      () => engine.invoke('agent.continue', t.id),
      () => engine.invoke('decision.answer', 'whatever', { kind: 'option', index: 0 })
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
  it('returns the existing workspace for the same path and refuses a different one', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    const first = await engine.invoke('workspace.open', repoPath)
    expect(await engine.invoke('workspace.open', repoPath)).toEqual(first)
    if (process.platform === 'win32') {
      expect(await engine.invoke('workspace.open', repoPath.toUpperCase())).toEqual(first)
    }

    const other = await makeRepo('other')
    await expect(engine.invoke('workspace.open', other)).rejects.toThrow('Mainbus MVP supports one workspace')
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
    await expect(engine.invoke('role.get')).rejects.toThrow('Open a workspace first')
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
