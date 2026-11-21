import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runGit } from './git/git'
import { scratchPathFor, ticketFoldersFor, type HomePaths } from './home'
import { createEngine, type Engine } from './index'
import { FakeRuntime, type FakeStep } from './runtime/fakeRuntime'
import type { ExecFn } from './runtime/resolveClaude'
import { copyTemplateRepo, testHome } from './testFixtures'

// A fake runtime, a temporary data home and a temporary custom root: nothing here touches the user's data or any real drive.
vi.setConfig({ testTimeout: 30_000 })

const migrationsDir = path.join(import.meta.dirname, 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })
const WAIT: FakeStep[] = [{ emit: { kind: 'session', sessionId: 'sess' } }, { waitForSend: true }]

let tmp: string
let root: string
let paths: HomePaths
let engines: Engine[]

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-tfl-'))
  root = path.join(tmp, 'fast', 'mb')
  paths = await testHome(path.join(tmp, 'home'))
  engines = []
})
afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const input = (title: string) => ({ title, intent: title, spec: '', criteria: [], labels: [], column: 'ready' as const })

async function setup() {
  const runtime = new FakeRuntime(WAIT)
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec })
  engines.push(engine)
  const repo = path.join(tmp, 'alpha')
  await copyTemplateRepo(repo)
  const ws = await engine.invoke('workspace.open', repo)
  return { engine, runtime, ws }
}

describe('the ticket folders location', () => {
  it('is empty by default, so a ticket starts in the data home', async () => {
    const { engine, runtime, ws } = await setup()
    expect((await engine.invoke('settings.get')).ticketFoldersLocation).toBeNull()
    const t = await engine.invoke('ticket.create', input('Default'))
    await engine.invoke('agent.start', t.id)
    await runtime.started(1)
    expect(runtime.specs[0]!.cwd.startsWith(ticketFoldersFor(paths, ws.slug))).toBe(true)
  })

  it('puts a new ticket in the custom root, keeps an older ticket where it was, and removes the folder at Done', async () => {
    const { engine, runtime, ws } = await setup()
    const before = await engine.invoke('ticket.create', input('Before'))
    await engine.invoke('agent.start', before.id)
    await runtime.started(1)
    const oldCwd = runtime.specs[0]!.cwd
    expect(oldCwd.startsWith(paths.worktrees)).toBe(true)

    const saved = await engine.invoke('settings.setTicketFoldersLocation', root)
    expect(saved.settings.ticketFoldersLocation).toBe(root)
    // The data home keeps the database and the settings.
    expect(existsSync(paths.db)).toBe(true)

    const after = await engine.invoke('ticket.create', input('After'))
    await engine.invoke('agent.start', after.id)
    await runtime.started(2)
    const spec = runtime.specs[1]!
    expect(spec.cwd.startsWith(path.join(root, 'work', ws.slug))).toBe(true)
    expect(spec.tempDir.startsWith(path.join(root, 'scratch', ws.slug))).toBe(true)
    expect(spec.tempDir).toBe(scratchPathFor(paths, spec.cwd))
    expect(spec.additionalDirectories).toContain(spec.tempDir)
    expect(existsSync(spec.cwd)).toBe(true)

    // The older ticket's recorded folder and scratch are untouched.
    const board = (await engine.invoke('board.get')).tickets
    expect(board.find((t) => t.id === before.id)!.worktreePath).toBe(oldCwd)
    expect(existsSync(oldCwd)).toBe(true)
    expect(scratchPathFor(paths, oldCwd).startsWith(paths.scratch)).toBe(true)

    await engine.invoke('agent.stop', after.id)
    await vi.waitFor(async () => expect(await engine.invoke('ticket.move', after.id, 'done')).toBe('moved'))
    expect(existsSync(spec.cwd)).toBe(false)
    expect(existsSync(spec.tempDir)).toBe(false)
    expect(existsSync(oldCwd)).toBe(true)
  })

  it('reports a long path as a warning, and null puts new tickets back in the data home', async () => {
    const { engine, runtime, ws } = await setup()
    const long = path.join(tmp, 'x'.repeat(100))
    const saved = await engine.invoke('settings.setTicketFoldersLocation', long)
    expect(saved.settings.ticketFoldersLocation).toBe(long)
    if (process.platform === 'win32') expect(saved.warning).toContain('characters')

    expect((await engine.invoke('settings.setTicketFoldersLocation', null)).settings.ticketFoldersLocation).toBeNull()
    const t = await engine.invoke('ticket.create', input('Home again'))
    await engine.invoke('agent.start', t.id)
    await runtime.started(1)
    expect(runtime.specs[0]!.cwd.startsWith(ticketFoldersFor(paths, ws.slug))).toBe(true)
  })

  it('refuses a folder inside a workspace repository, and keeps the old setting', async () => {
    const { engine, ws } = await setup()
    await expect(engine.invoke('settings.setTicketFoldersLocation', path.join(ws.repoPath, 'tickets'))).rejects.toThrow(/repository/)
    expect((await engine.invoke('settings.get')).ticketFoldersLocation).toBeNull()
    await expect(engine.invoke('settings.setTicketFoldersLocation', 'relative')).rejects.toThrow(/full path/)
  })

  it('lets the orchestrator read, and intake match, the data home and the custom root, plus where open tickets are', async () => {
    const runtime = new FakeRuntime(WAIT, { orchestrator: [{ emit: { kind: 'session', sessionId: 's' } }, { waitForSend: true }] })
    const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec })
    engines.push(engine)
    const repo = path.join(tmp, 'beta')
    await copyTemplateRepo(repo)
    const ws = await engine.invoke('workspace.open', repo)
    await engine.invoke('settings.setTicketFoldersLocation', root)

    await engine.invoke('orchestrator.send', 'Hello')
    await vi.waitFor(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    const dirs = runtime.orchestratorSpecs[0]!.additionalDirectories
    expect(dirs).toContain(ticketFoldersFor(paths, ws.slug))
    expect(dirs).toContain(ticketFoldersFor({ ...paths, worktrees: path.join(root, 'work') }, ws.slug))

    // An agent working in a ticket folder under the custom root files a ticket in this workspace.
    const created = await engine.intake('create', {
      title: 'From a ticket folder',
      intent: 'Found while working here',
      source: { agent: 'codex', cwd: path.join(root, 'work', ws.slug, '3-thing') }
    })
    expect(created).toBeTruthy()
  })
})
