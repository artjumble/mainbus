import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { EngineEvent } from '../shared/api'
import type { Ticket } from '../shared/domain'
import { runGit } from './git/git'
import { FakeClock } from './holds/clock'
import { resolveHome, type HomePaths } from './home'
import { createEngine, type Engine } from './index'
import { makeRepo } from './intake/testBoard'
import { FakeRuntime, type FakeStep } from './runtime/fakeRuntime'
import type { ExecFn } from './runtime/resolveClaude'
import type { SetupCommandRequest, SetupCommandResult } from './setup/setupCommand'

// Each test starts an engine over a real repository: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

const migrationsDir = path.join(import.meta.dirname, 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-base-tests-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  engines = []
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const JUNIT = '<testsuites><testsuite><testcase classname="math" name="adds"/><testcase classname="math" name="divides"><failure/></testcase></testsuite></testsuites>'

/** Stands in for the shell: writes the results file the command names, as a failing JUnit run does. */
async function fakeCommand(req: SetupCommandRequest): Promise<SetupCommandResult> {
  const file = /"([^"]+\.xml)"/.exec(req.command)?.[1]
  if (file) await fs.writeFile(file, JUNIT)
  return { exitCode: 1, timedOut: false, aborted: false, tail: [] }
}

async function makeEngine(script: FakeStep[]): Promise<{ engine: Engine; runtime: FakeRuntime; events: EngineEvent[] }> {
  const runtime = new FakeRuntime(script)
  const engine = await createEngine({
    paths,
    migrationsDir,
    runtime,
    git: runGit,
    exec,
    baseTests: { commands: fakeCommand, timer: new FakeClock(new Date()) }
  })
  engines.push(engine)
  const events: EngineEvent[] = []
  engine.on((e) => events.push(e))
  await engine.invoke('workspace.open', repoPath)
  return { engine, runtime, events }
}

const newTicket = (engine: Engine, title: string): Promise<Ticket> =>
  engine.invoke('ticket.create', { title, intent: `Do ${title}`, spec: '', criteria: [], labels: [], column: 'ready' })

async function recordRun(engine: Engine): Promise<void> {
  await engine.invoke('workspace.setTestCommands', [{ name: 'Unit', command: 'run --out <results>', format: 'junit-xml' }])
  await engine.invoke('workspace.runBaseTests')
  await vi.waitFor(async () => expect((await engine.invoke('workspace.baseTests')).summary).not.toBeNull(), { timeout: 15_000 })
}

describe('base branch tests', () => {
  test('a manual run records the failing test, and the view and the Workspace settings read it back', async () => {
    const { engine, events } = await makeEngine([{ emit: { kind: 'session', sessionId: 's' } }, { waitForSend: true }])
    expect((await engine.invoke('workspace.baseTests')).summary).toBeNull()
    await recordRun(engine)

    const view = await engine.invoke('workspace.baseTests')
    expect(view.summary!.knownFailures).toMatchObject([{ command: 'Unit', test: 'math > divides', intermittent: false }])
    expect(view.results[0]).toMatchObject({ name: 'Unit', exitCode: 1, failures: ['math > divides'] })
    expect(events.some((e) => e.type === 'baseTests.changed')).toBe(true)
    // It ran in the engine's own baseline folder, which is a worktree of the repository.
    expect((await fs.stat(path.join(paths.baselines, (await engine.invoke('workspace.get'))!.slug, 'r', 'README.md'))).isFile()).toBe(true)
  })

  test('the commands are refused for a bad list and the run for none', async () => {
    const { engine } = await makeEngine([{ waitForSend: true }])
    await expect(engine.invoke('workspace.setTestCommands', [{ name: 'Unit', command: 'no placeholder', format: 'junit-xml' }])).rejects.toThrow('<results>')
    await expect(engine.invoke('workspace.runBaseTests')).rejects.toThrow('Add a test command first')
  })

  test('a started role is told the known failure in its system prompt', async () => {
    const { engine, runtime } = await makeEngine([{ emit: { kind: 'session', sessionId: 's' } }, { waitForSend: true }])
    await recordRun(engine)
    const t = await newTicket(engine, 'Do it')
    await engine.invoke('agent.start', t.id)
    await vi.waitFor(() => expect(runtime.specs).toHaveLength(1), { timeout: 15_000 })
    const prompt = runtime.specs[0]!.appendSystemPrompt
    expect(prompt).toContain('## Known test results on the base branch')
    expect(prompt).toContain('- Unit: math > divides')
  })

  test('the orchestrator’s read tools and the intake read show the known failure', async () => {
    const { engine } = await makeEngine([{ waitForSend: true }])
    await recordRun(engine)
    const t = await newTicket(engine, 'Do it')
    const got = await engine.intake('get', { cwd: repoPath, number: t.number })
    expect(got.baseTests).toMatchObject({ base: expect.any(String), error: null, knownFailures: [{ command: 'Unit', test: 'math > divides', intermittent: false }] })
  })

  test('removing the workspace removes its baseline worktree', async () => {
    const { engine } = await makeEngine([{ waitForSend: true }])
    await recordRun(engine)
    const ws = (await engine.invoke('workspace.get'))!
    const folder = path.join(paths.baselines, ws.slug)
    await engine.invoke('workspace.remove', ws.id)
    await expect(fs.access(folder)).rejects.toThrow()
    const list = await runGit(['worktree', 'list', '--porcelain'], repoPath)
    expect(list.stdout.match(/^worktree /gm)).toHaveLength(1)
  })
})
