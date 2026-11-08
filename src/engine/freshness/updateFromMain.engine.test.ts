import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardTicket } from '../../shared/api'
import { createEngine, type Engine } from '../index'
import { runCommand } from '../git/command'
import { FakeGh } from '../git/fakeGh'
import { runGit } from '../git/git'
import { FakeClock } from '../holds/clock'
import { resolveHome } from '../home'
import { FakeRuntime } from '../runtime/fakeRuntime'

vi.setConfig({ testTimeout: 60_000 })
const WAIT = { timeout: 20_000, interval: 50 }
const INTERVAL = 1000
const migrationsDir = path.join(process.cwd(), 'src', 'engine', 'db', 'migrations')

let tmp: string
let repo: string
let origin: string
let engines: Engine[]
let gh: FakeGh
let clock: FakeClock
let runtime: FakeRuntime
let engine: Engine
let implementer: string

async function git(args: string[], cwd = repo): Promise<string> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

async function commit(file: string, content: string, cwd: string, message = `change ${file}`): Promise<void> {
  await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true })
  await fs.writeFile(path.join(cwd, file), content)
  await git(['add', '.'], cwd)
  await git(['commit', '-m', message], cwd)
}

/** Another clone pushes to origin's main, as a merged pull request would. */
async function pushToOriginMain(file: string, content: string): Promise<void> {
  const other = path.join(tmp, `other-${Date.now()}`)
  await git(['clone', '-q', origin, other], tmp)
  await commit(file, content, other)
  await git(['push', '-q', 'origin', 'main'], other)
  await fs.rm(other, { recursive: true, force: true, maxRetries: 5 })
}

async function makeEngine(): Promise<Engine> {
  gh = new FakeGh()
  clock = new FakeClock(new Date())
  runtime = new FakeRuntime([{ waitForSend: true }])
  const paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  const e = await createEngine({
    paths,
    migrationsDir,
    runtime,
    git: runGit,
    exec: async () => ({ code: 1, stdout: '', stderr: 'no claude here' }),
    commands: gh.runner(runCommand),
    freshness: { timer: clock, intervalMs: INTERVAL }
  })
  engines.push(e)
  await e.invoke('workspace.open', repo)
  await e.invoke('workspace.setOpenPrOnReview', true)
  implementer = (await e.invoke('lineup.get')).find((r) => r.name === 'Implementer')!.id
  return e
}

async function newTicket(title = 'Add a migration'): Promise<BoardTicket> {
  const t = await engine.invoke('ticket.create', { title, intent: 'Add migration 0002', spec: '', criteria: [], labels: [], column: 'ready' } as never)
  return (await board()).find((x) => x.id === t.id)!
}

const board = async (): Promise<BoardTicket[]> => (await engine.invoke('board.get')).tickets

const ticketNow = async (id: string): Promise<BoardTicket> => (await board()).find((t) => t.id === id)!

/** Runs the freshness check that the interval timer would. */
const tick = () => clock.advance(INTERVAL)

beforeEach(async () => {
  engines = []
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-update-'))
  repo = path.join(tmp, 'repo')
  origin = path.join(tmp, 'origin.git')
  await fs.mkdir(repo)
  await git(['init', '-b', 'main'])
  await commit('migrations/journal.txt', '0001_init\n', repo)
  await git(['init', '--bare', '-b', 'main', origin], tmp)
  await git(['remote', 'add', 'origin', origin])
  await git(['push', '-q', '-u', 'origin', 'main'])
  engine = await makeEngine()
})

afterEach(async () => {
  for (const e of engines) await e.dispose().catch(() => {})
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
})

describe('a new ticket branch', () => {
  it('starts from origin/main when GitHub is ahead, leaving the checkout and the local main alone', async () => {
    await pushToOriginMain('merged.txt', 'from a merged PR\n')
    const localMain = await git(['rev-parse', 'refs/heads/main'])
    await fs.writeFile(path.join(repo, 'wip.txt'), 'mine\n')

    const t = await newTicket()
    await engine.invoke('agent.start', t.id, { roleIds: [implementer] })
    const spec = await vi.waitFor(() => {
      expect(runtime.specs[0]).toBeDefined()
      return runtime.specs[0]!
    }, WAIT)

    await expect(fs.access(path.join(spec.cwd, 'merged.txt'))).resolves.toBeUndefined()
    expect(await git(['rev-parse', 'refs/heads/main'])).toBe(localMain)
    expect(await git(['rev-parse', 'HEAD'])).toBe(localMain)
    expect(await git(['status', '--porcelain'])).toBe('?? wip.txt')
    const { events } = await engine.invoke('thread.get', t.id)
    expect(events.filter((e) => e.event.kind === 'notice')).toEqual([])
    // Branched from the newest main, so it isn't behind.
    await tick()
    expect((await ticketNow(t.id)).freshness).toMatchObject({ behind: 0, conflicts: [] })
  })

  it('starts from the local main with a notice in the thread when origin cannot be fetched', async () => {
    await git(['remote', 'set-url', 'origin', path.join(tmp, 'missing.git')])
    const t = await newTicket()
    await engine.invoke('agent.start', t.id, { roleIds: [implementer] })
    await vi.waitFor(() => expect(runtime.specs[0]).toBeDefined(), WAIT)
    const { events } = await engine.invoke('thread.get', t.id)
    const notice = events.find((e) => e.event.kind === 'notice')?.event
    expect(notice).toMatchObject({ kind: 'notice', text: expect.stringMatching(/^This branch starts from your local main: git fetch failed/) })
  })
})

describe('Update from main', () => {
  /** A ticket that added migration 0002_b to the journal and handed off, with its PR open. */
  async function ticketInReview(): Promise<{ t: BoardTicket; cwd: string }> {
    const t = await newTicket()
    await engine.invoke('agent.start', t.id, { roleIds: [implementer] })
    const spec = await vi.waitFor(() => {
      expect(runtime.specs[0]).toBeDefined()
      return runtime.specs[0]!
    }, WAIT)
    await commit('migrations/journal.txt', '0001_init\n0002_b\n', spec.cwd)
    await commit('migrations/0002_b.sql', 'select 2;\n', spec.cwd)
    await spec.roleTools.handoff({ summary: 'Added 0002_b', notesForNext: '' })
    await vi.waitFor(async () => expect((await ticketNow(t.id)).pr).not.toBeNull(), WAIT)
    return { t, cwd: spec.cwd }
  }

  it('shows Behind, then Conflicts with the files; the Implementer-only run merges, and the PR is updated, not reopened', async () => {
    const { t, cwd } = await ticketInReview()
    const localMain = await git(['rev-parse', 'refs/heads/main'])
    await tick()
    expect((await ticketNow(t.id)).freshness).toMatchObject({ behind: 0 })

    // Someone's PR with the same migration number is merged on GitHub.
    await pushToOriginMain('unrelated.txt', 'x\n')
    await tick()
    expect((await ticketNow(t.id)).freshness).toMatchObject({ baseBranch: 'main', base: 'origin/main', behind: 1, conflicts: [] })
    await pushToOriginMain('migrations/journal.txt', '0001_init\n0002_a\n')
    await tick()
    expect((await ticketNow(t.id)).freshness).toMatchObject({ behind: 2, conflicts: ['migrations/journal.txt'] })
    expect(await git(['rev-parse', 'refs/heads/main'])).toBe(localMain)

    await engine.invoke('ticket.updateFromMain', t.id)

    const spec = await vi.waitFor(() => {
      expect(runtime.specs[1]).toBeDefined()
      return runtime.specs[1]!
    }, WAIT)
    expect(spec.role).toBe('Implementer')
    expect(spec.appendSystemPrompt).toContain('git merge origin/main')
    expect(spec.appendSystemPrompt).toContain('migrations/journal.txt')
    expect(spec.appendSystemPrompt).toContain('renumber')
    const thread = await engine.invoke('thread.get', t.id)
    expect(thread.runs.at(-1)).toBeDefined()
    expect(thread.events.some((e) => e.event.kind === 'notice' && /Update from main/.test(e.event.text))).toBe(true)
    // The run is the Implementer alone.
    expect((await ticketNow(t.id)).lineup.map((r) => r.name)).toEqual(['Implementer'])

    // What the agent does: merge, resolve, renumber, commit.
    await runGit(['merge', 'origin/main'], spec.cwd)
    await fs.writeFile(path.join(spec.cwd, 'migrations/journal.txt'), '0001_init\n0002_a\n0003_b\n')
    await git(['mv', 'migrations/0002_b.sql', 'migrations/0003_b.sql'], spec.cwd)
    await git(['add', '-A'], spec.cwd)
    await git(['commit', '--no-edit'], spec.cwd)
    expect(spec.cwd).toBe(cwd)
    await spec.roleTools.handoff({ summary: 'Merged main and renumbered 0002_b to 0003_b', notesForNext: '' })

    await vi.waitFor(async () => expect((await ticketNow(t.id)).freshness).toMatchObject({ behind: 0, conflicts: [] }), WAIT)
    expect((await ticketNow(t.id)).state.column).toBe('review')
    // Pushed again, and the PR from before was kept.
    expect(gh.prs).toHaveLength(1)
    expect(gh.calls.filter((c) => c[0] === 'pr' && c[1] === 'create')).toHaveLength(1)
    const branch = (await ticketNow(t.id)).branch!
    expect(await git(['rev-parse', `refs/heads/${branch}`])).toBe(await git(['rev-parse', `refs/remotes/origin/${branch}`]))
    expect(await git(['rev-parse', 'refs/heads/main'])).toBe(localMain)
  })

  it('ends a paused run as stopped, then starts the Implementer-only run; it is refused while a role is working', async () => {
    const t = await newTicket()
    await engine.invoke('agent.start', t.id, { roleIds: [implementer] })
    await vi.waitFor(() => expect(runtime.specs[0]).toBeDefined(), WAIT)
    await pushToOriginMain('news.txt', 'x\n')
    await tick()
    expect((await ticketNow(t.id)).freshness).toMatchObject({ behind: 1 })

    await expect(engine.invoke('ticket.updateFromMain', t.id)).rejects.toThrow(/role is working/)

    await engine.invoke('agent.pause', t.id)
    await engine.invoke('ticket.updateFromMain', t.id)

    await vi.waitFor(() => expect(runtime.specs[1]).toBeDefined(), WAIT)
    const { events } = await engine.invoke('thread.get', t.id)
    expect(events.filter((e) => e.event.kind === 'stopped')).toHaveLength(1)
    expect((await ticketNow(t.id)).state.agentStatus).toBe('working')
  })

  it('is refused for a ticket that is not behind, and for a Done one', async () => {
    const { t } = await ticketInReview()
    await tick()
    await expect(engine.invoke('ticket.updateFromMain', t.id)).rejects.toThrow(/is not behind main/)
    await pushToOriginMain('news.txt', 'x\n')
    await tick()
    await engine.invoke('ticket.move', t.id, 'done')
    expect((await ticketNow(t.id)).freshness).toBeNull()
    await expect(engine.invoke('ticket.updateFromMain', t.id)).rejects.toThrow(/is Done/)
  })
})
