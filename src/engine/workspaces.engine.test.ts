import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent } from '../shared/api'
import type { Workspace } from '../shared/domain'
import { runGit } from './git/git'
import { attachmentFoldersFor, ticketFoldersFor, type HomePaths } from './home'
import { createEngine, type Engine } from './index'
import { FakeRuntime, type FakeStep } from './runtime/fakeRuntime'
import type { ExecFn } from './runtime/resolveClaude'
import type { AgentRuntime } from './runtime/types'
import { eventually } from './testWait'
import { copyTemplateRepo, testHome } from './testFixtures'

// Two throwaway repos, a fake runtime and a temporary home: nothing here touches the user's board or data.

// Each test starts an engine over real repositories: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

const migrationsDir = path.join(import.meta.dirname, 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

let tmp: string
let paths: HomePaths
let engines: Engine[]

async function git(args: string[], cwd: string): Promise<string> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

async function makeRepo(name: string, parent = tmp): Promise<string> {
  const dir = path.join(parent, name)
  await copyTemplateRepo(dir)
  return dir
}

async function makeEngine(runtime: AgentRuntime | null, extra: Partial<Parameters<typeof createEngine>[0]> = {}): Promise<Engine> {
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec, ...extra })
  engines.push(engine)
  return engine
}

const WAIT: FakeStep[] = [{ emit: { kind: 'session', sessionId: 'sess' } }, { waitForSend: true }]

function ticketInput(title: string, column: 'ready' | 'backlog' = 'ready') {
  return { title, intent: title, spec: '', criteria: [], labels: [], column }
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-multiws-'))
  paths = await testHome(path.join(tmp, 'home'))
  engines = []
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** Two repos with a workspace each; the second is focused. */
async function two(runtime: AgentRuntime | null = new FakeRuntime(WAIT)) {
  const engine = await makeEngine(runtime)
  const repoA = await makeRepo('alpha')
  const repoB = await makeRepo('bravo')
  const a = await engine.invoke('workspace.open', repoA)
  const b = await engine.invoke('workspace.open', repoB)
  return { engine, repoA, repoB, a, b }
}

describe('open, focus and list', () => {
  it('opens several repos, focuses the newest, and opening one again only focuses it', async () => {
    const { engine, a, b } = await two()
    expect(a.id).not.toBe(b.id)
    expect((await engine.invoke('workspace.list')).map((w) => w.name)).toEqual(['alpha', 'bravo'])
    expect((await engine.invoke('workspace.get'))?.id).toBe(b.id)

    expect((await engine.invoke('workspace.open', a.repoPath)).id).toBe(a.id)
    expect((await engine.invoke('workspace.get'))?.id).toBe(a.id)
    expect(await engine.invoke('workspace.list')).toHaveLength(2)
  })

  it('focus changes what the board shows, tells the renderer, and is remembered across a restart', async () => {
    const { engine, a, b } = await two()
    const seen: EngineEvent[] = []
    engine.on((e) => seen.push(e))
    await engine.invoke('ticket.create', ticketInput('Bravo ticket'))
    await engine.invoke('workspace.focus', a.id)
    expect(seen).toContainEqual({ type: 'workspaces.changed', focusedId: a.id })
    expect((await engine.invoke('board.get')).tickets).toEqual([])
    expect((await engine.invoke('board.get', b.id)).tickets.map((t) => t.title)).toEqual(['Bravo ticket'])

    await engine.dispose()
    const again = await makeEngine(new FakeRuntime(WAIT))
    expect((await again.invoke('workspace.get'))?.id).toBe(a.id)
    await expect(again.invoke('workspace.focus', 'nope')).rejects.toThrow(/Unknown workspace/)
  })

  it('gives two repos with the same name their own ticket folders', async () => {
    const engine = await makeEngine(new FakeRuntime(WAIT))
    const one = await engine.invoke('workspace.open', await makeRepo('app', path.join(tmp, 'x')))
    const two = await engine.invoke('workspace.open', await makeRepo('app', path.join(tmp, 'y')))
    expect([one.slug, two.slug]).toEqual(['app', 'app-2'])
  })

  it('tickets are numbered per workspace and commands can name a workspace', async () => {
    const { engine, a, b } = await two()
    const inA = await engine.invoke('ticket.create', ticketInput('In A'), a.id)
    const inB = await engine.invoke('ticket.create', ticketInput('In B'))
    expect([inA.workspaceId, inA.number]).toEqual([a.id, 1])
    expect([inB.workspaceId, inB.number]).toEqual([b.id, 1])
    await expect(engine.invoke('board.get', 'nope')).rejects.toThrow(/Unknown workspace/)
  })
})

describe('agents in every workspace', () => {
  it('runs an agent in each workspace at once, in that workspace', async () => {
    const runtime = new FakeRuntime(WAIT)
    const { engine, a, b } = await two(runtime)
    const inA = await engine.invoke('ticket.create', ticketInput('Alpha'), a.id)
    const inB = await engine.invoke('ticket.create', ticketInput('Bravo'), b.id)
    await engine.invoke('agent.start', inA.id)
    await engine.invoke('agent.start', inB.id)
    await runtime.started(2)
    expect(runtime.specs).toHaveLength(2)
    const cwds = runtime.specs.map((s) => s.cwd)
    expect(cwds.some((c) => c.startsWith(ticketFoldersFor(paths, a.slug)))).toBe(true)
    expect(cwds.some((c) => c.startsWith(ticketFoldersFor(paths, b.slug)))).toBe(true)
  })

  it('"tickets at once" is saved per workspace and cannot exceed the agents-at-once limit', async () => {
    const { engine, a, b } = await two()
    await engine.invoke('settings.setMaxAgents', 2)
    await expect(engine.invoke('workspace.setUnattendedAtOnce', 3, a.id)).rejects.toThrow('from 1 to 2')
    await expect(engine.invoke('workspace.setUnattendedAtOnce', 1.5, a.id)).rejects.toThrow()
    expect((await engine.invoke('workspace.setUnattendedAtOnce', 2, a.id)).unattendedAtOnce).toBe(2)
    const ws = await engine.invoke('workspace.list')
    expect(ws.find((w) => w.id === a.id)?.unattendedAtOnce).toBe(2)
    expect(ws.find((w) => w.id === b.id)?.unattendedAtOnce).toBe(1)
  })

  it('the cap on agents running at once is global: a second workspace waits in line', async () => {
    const runtime = new FakeRuntime(WAIT)
    const { engine, a, b } = await two(runtime)
    await engine.invoke('settings.setMaxAgents', 1)
    const inA = await engine.invoke('ticket.create', ticketInput('Alpha'), a.id)
    const inB = await engine.invoke('ticket.create', ticketInput('Bravo'), b.id)
    await engine.invoke('agent.start', inA.id)
    await runtime.started(1)
    expect(runtime.specs).toHaveLength(1)
    await engine.invoke('agent.start', inB.id)
    const bravo = (await engine.invoke('board.get', b.id)).tickets[0]!
    expect(bravo.state).toMatchObject({ column: 'in_progress', agentStatus: 'queued' })
    expect(runtime.specs).toHaveLength(1)

    // Stopping the first workspace's agent frees the slot for the other workspace's.
    await engine.invoke('agent.stop', inA.id)
    await runtime.started(2)
    expect(runtime.specs).toHaveLength(2)
  })

  it('both agents resume after a restart', async () => {
    const steps: FakeStep[] = [{ emit: { kind: 'session', sessionId: 'sess-1' } }, { waitForSend: true }]
    const first = await makeEngine(new FakeRuntime(steps))
    const a = await first.invoke('workspace.open', await makeRepo('alpha'))
    const b = await first.invoke('workspace.open', await makeRepo('bravo'))
    const inA = await first.invoke('ticket.create', ticketInput('Alpha'), a.id)
    const inB = await first.invoke('ticket.create', ticketInput('Bravo'), b.id)
    await first.invoke('agent.start', inA.id)
    await first.invoke('agent.start', inB.id)
    await eventually(async () => {
      for (const id of [inA.id, inB.id]) {
        expect((await first.invoke('thread.get', id)).events.some((e) => e.event.kind === 'session')).toBe(true)
      }
    })
    await first.dispose()

    const runtime = new FakeRuntime(steps)
    await makeEngine(runtime)
    await runtime.started(2)
    expect(runtime.specs).toHaveLength(2)
    expect(runtime.specs.map((s) => s.resumeSessionId)).toEqual(['sess-1', 'sess-1'])
  })

  it('a ticket cannot start in a workspace that was removed', async () => {
    const { engine, a } = await two()
    const t = await engine.invoke('ticket.create', ticketInput('Alpha'), a.id)
    await engine.invoke('workspace.remove', a.id)
    await expect(engine.invoke('agent.start', t.id)).rejects.toThrow(/workspace/i)
  })
})

describe('workspace.remove', () => {
  it('is refused while an agent is open, naming the ticket, and removes nothing', async () => {
    const { engine, a } = await two()
    const t = await engine.invoke('ticket.create', ticketInput('Alpha'), a.id)
    await engine.invoke('agent.start', t.id)
    await expect(engine.invoke('workspace.remove', a.id)).rejects.toThrow(`#${t.number}`)
    expect((await engine.invoke('workspace.list')).map((w) => w.id)).toContain(a.id)

    await engine.invoke('agent.stop', t.id)
    await engine.invoke('workspace.remove', a.id)
    expect((await engine.invoke('workspace.list')).map((w) => w.id)).not.toContain(a.id)
  })

  it('is refused while a ticket folder has uncommitted changes', async () => {
    const { engine, a } = await two()
    const t = await engine.invoke('ticket.create', ticketInput('Alpha'), a.id)
    await engine.invoke('agent.start', t.id)
    const folder = (await engine.invoke('board.get', a.id)).tickets[0]!.worktreePath!
    await engine.invoke('agent.stop', t.id)
    await fs.writeFile(path.join(folder, 'wip.txt'), 'unsaved work')
    await expect(engine.invoke('workspace.remove', a.id)).rejects.toThrow(/uncommitted/)
    expect((await engine.invoke('workspace.list')).map((w) => w.id)).toContain(a.id)
    expect(await fs.readFile(path.join(folder, 'wip.txt'), 'utf8')).toBe('unsaved work')
  })

  it('removes the ticket folders but never the repo or its branches, and moves focus', async () => {
    const { engine, a, b, repoA } = await two()
    const t = await engine.invoke('ticket.create', ticketInput('Alpha'), a.id)
    await engine.invoke('agent.start', t.id)
    const { worktreePath, branch } = (await engine.invoke('board.get', a.id)).tickets[0]!
    await engine.invoke('agent.stop', t.id)
    await engine.invoke('workspace.focus', a.id)

    const seen: EngineEvent[] = []
    engine.on((e) => seen.push(e))
    expect(await engine.invoke('workspace.remove', a.id)).toEqual({ keptFolders: [] })

    await expect(fs.access(worktreePath!)).rejects.toThrow()
    expect((await fs.stat(repoA)).isDirectory()).toBe(true)
    expect(await git(['branch', '--list', branch!], repoA)).toContain(branch!)
    expect((await engine.invoke('workspace.get'))?.id).toBe(b.id)
    expect(seen).toContainEqual({ type: 'workspaces.changed', focusedId: b.id })
    await expect(engine.invoke('board.get', a.id)).rejects.toThrow(/Unknown workspace/)
  })

  it('opening the repo again brings the workspace back with its board', async () => {
    const { engine, a, repoA } = await two()
    await engine.invoke('ticket.create', ticketInput('Alpha'), a.id)
    await engine.invoke('workspace.remove', a.id)
    const back = await engine.invoke('workspace.open', repoA)
    expect(back.id).toBe(a.id)
    expect((await engine.invoke('board.get')).tickets.map((t) => t.title)).toEqual(['Alpha'])
  })

  it('fails its pending proposals, acknowledges its wakes and turns its unattended mode off', async () => {
    const { engine, a } = await two()
    await engine.invoke('unattended.set', true, a.id)
    expect((await engine.invoke('unattended.get', a.id)).on).toBe(true)
    await engine.invoke('workspace.remove', a.id)
    await expect(engine.invoke('unattended.get', a.id)).rejects.toThrow(/Unknown workspace/)
    // Open again: the mode is off, not remembered as on.
    const back = await engine.invoke('workspace.open', a.repoPath)
    expect((await engine.invoke('unattended.get', back.id)).on).toBe(false)
  })
})

describe('unattended mode per workspace', () => {
  it('starts only its own workspace’s Ready tickets, and is remembered per workspace', async () => {
    const runtime = new FakeRuntime(WAIT)
    const { engine, a, b } = await two(runtime)
    const inA = await engine.invoke('ticket.create', ticketInput('Alpha'), a.id)
    const inB = await engine.invoke('ticket.create', ticketInput('Bravo'), b.id)

    await engine.invoke('unattended.set', true, a.id)
    await runtime.started(1)
    expect(runtime.specs).toHaveLength(1)
    expect(runtime.specs[0]!.cwd.startsWith(ticketFoldersFor(paths, a.slug))).toBe(true)
    expect((await engine.invoke('unattended.get', b.id)).on).toBe(false)
    expect((await engine.invoke('board.get', b.id)).tickets[0]!.state.column).toBe('ready')
    expect(inB.id).not.toBe(inA.id)

    // Remembered for A alone.
    await engine.dispose()
    const again = await makeEngine(new FakeRuntime(WAIT))
    await eventually(async () => expect((await again.invoke('unattended.get', a.id)).on).toBe(true))
    expect((await again.invoke('unattended.get', b.id)).on).toBe(false)
  })

  it('auto-allows permission requests only for the workspace whose mode is on', async () => {
    const request: FakeStep[] = [
      { emit: { kind: 'session', sessionId: 's' } },
      { requestPermission: { toolName: 'Bash', input: { command: 'npm install zod' }, toolUseId: 'tool-1' } },
      { waitForSend: true }
    ]
    const { engine, a, b } = await two(new FakeRuntime(request))
    await engine.invoke('unattended.set', true, a.id)
    const inA = await engine.invoke('ticket.create', ticketInput('Alpha', 'backlog'), a.id)
    const inB = await engine.invoke('ticket.create', ticketInput('Bravo', 'backlog'), b.id)
    await engine.invoke('agent.start', inA.id)
    await engine.invoke('agent.start', inB.id)

    // B's mode is off: the same request raises a permission card.
    await eventually(async () => expect((await engine.invoke('thread.get', inB.id)).decisions).toHaveLength(1))
    const pending = (await engine.invoke('thread.get', inB.id)).decisions[0]!
    expect(pending).toMatchObject({ kind: 'permission', status: 'pending' })

    // A's mode is on: it is allowed with a notice and no card.
    await eventually(async () =>
      expect(
        (await engine.invoke('thread.get', inA.id)).events.some((e) => e.event.kind === 'notice' && e.event.text.startsWith('Allowed by unattended mode'))
      ).toBe(true)
    )
    expect((await engine.invoke('thread.get', inA.id)).decisions).toEqual([])
    expect((await engine.invoke('thread.get', inB.id)).events.some((e) => e.event.kind === 'notice' && e.event.text.startsWith('Allowed by unattended mode'))).toBe(false)
  })
})

describe('intake', () => {
  it('files a ticket into the workspace that contains the caller’s folder, and refuses any other', async () => {
    const { engine, a, b, repoA, repoB } = await two()
    const source = (cwd: string) => ({ agent: 'codex', cwd })
    const inA = await engine.intake('create', { title: 'From A', intent: 'x', source: source(path.join(repoA, 'src')) })
    const inB = await engine.intake('create', { title: 'From B', intent: 'y', source: source(repoB) })
    expect([inA.number, inB.number]).toEqual([1, 1])
    expect((await engine.invoke('board.get', a.id)).tickets.map((t) => t.title)).toEqual(['From A'])
    expect((await engine.invoke('board.get', b.id)).tickets.map((t) => t.title)).toEqual(['From B'])

    // An agent working in one of the ticket folders is in that workspace too.
    const folder = path.join(ticketFoldersFor(paths, a.slug), '1-from-a')
    expect((await engine.intake('create', { title: 'From a ticket folder', intent: 'z', source: source(folder) })).number).toBe(2)

    await expect(engine.intake('create', { title: 'Nowhere', intent: 'n', source: source(tmp) })).rejects.toMatchObject({
      code: 'workspace_mismatch'
    })
    expect((await engine.intake('list', { cwd: repoB })).tickets.map((t) => t.title)).toEqual(['From B'])
    expect((await engine.intake('get', { cwd: repoA, number: 1 })).title).toBe('From A')
  })

  it('picks the deepest workspace when repos are nested', async () => {
    const engine = await makeEngine(new FakeRuntime(WAIT))
    const outer = await makeRepo('outer')
    const inner = await makeRepo('inner', outer)
    await engine.invoke('workspace.open', outer)
    const innerWs = await engine.invoke('workspace.open', inner)
    const made = await engine.intake('create', { title: 'Deep', intent: 'x', source: { agent: 'a', cwd: path.join(inner, 'src') } })
    expect(made.number).toBe(1)
    expect((await engine.invoke('board.get', innerWs.id)).tickets.map((t) => t.title)).toEqual(['Deep'])
  })
})

describe('the orchestrator across workspaces', () => {
  const ORCHESTRATOR: FakeStep[] = [
    { emit: { kind: 'session', sessionId: 'orch' } },
    { emit: { kind: 'turn_end', ok: true, interrupted: false } },
    ...[1, 2, 3, 4].flatMap((): FakeStep[] => [{ waitForSend: true }, { emit: { kind: 'turn_end', ok: true, interrupted: false } }])
  ]

  async function withOrchestrator() {
    const runtime = new FakeRuntime(WAIT, { orchestrator: ORCHESTRATOR })
    const { engine, a, b, repoA, repoB } = await two(runtime)
    const say = async (text: string) => {
      await eventually(async () => expect((await engine.invoke('orchestrator.get')).status).not.toBe('working'))
      await engine.invoke('orchestrator.send', text)
      await eventually(async () => expect((await engine.invoke('orchestrator.get')).status).toBe('idle'))
    }
    return { runtime, engine, a, b, repoA, repoB, say }
  }

  it('reads every workspace’s repo and ticket folders, and names the focused one in the header', async () => {
    const { runtime, a, b, repoA, repoB, say } = await withOrchestrator()
    await say('Hello')
    const spec = runtime.orchestratorSpecs[0]!
    expect(spec.additionalDirectories).toEqual([
      repoA,
      repoB,
      ticketFoldersFor(paths, a.slug),
      ticketFoldersFor(paths, b.slug),
      attachmentFoldersFor(paths, a.slug),
      attachmentFoldersFor(paths, b.slug)
    ])
    expect(spec.prompt).toContain('Focused workspace: bravo')
    expect(spec.appendSystemPrompt).toContain(ticketFoldersFor(paths, a.slug))
    expect(spec.appendSystemPrompt).toContain(ticketFoldersFor(paths, b.slug))
  })

  it('read tools take an optional workspace, and list_workspaces shows them all with their needs-you counts', async () => {
    const { runtime, engine, a, b, say } = await withOrchestrator()
    await engine.invoke('ticket.create', ticketInput('Alpha work'), a.id)
    await engine.invoke('ticket.create', ticketInput('Bravo work'), b.id)
    await say('Hello')
    const tools = runtime.orchestratorSpecs[0]!.tools

    const focused = await tools.listTickets({})
    expect(focused).toContain('Bravo work')
    expect(focused).not.toContain('Alpha work')
    expect(await tools.listTickets({ workspace: 'alpha' })).toContain('Alpha work')
    expect(await tools.listTickets({ workspace: a.id })).toContain('Alpha work')
    expect(await tools.getTicket({ workspace: 'ALPHA', number: 1 })).toContain('Alpha work')
    expect(await tools.listTickets({ workspace: 'nowhere' })).toMatch(/No workspace "nowhere".*alpha.*bravo/)

    const listed = await tools.listWorkspaces()
    expect(listed).toContain('Workspaces (2):')
    expect(listed).toMatch(/alpha .*Needs you: 0/)
    expect(listed).toMatch(/bravo .*Needs you: 0 · focused/)
  })

  it('a propose tool acts on the ticket’s own workspace, whichever one is focused', async () => {
    const asking: FakeStep[] = [
      { emit: { kind: 'session', sessionId: 'orch' } },
      { emit: { kind: 'turn_end', ok: true, interrupted: false } },
      { waitForSend: true },
      // The focused workspace (bravo) has no #1: this one is refused and stores nothing.
      { callTool: 'proposeStart', args: { ticket: 1 } },
      { callTool: 'proposeStart', args: { ticket: 1, workspace: 'alpha' } },
      { emit: { kind: 'turn_end', ok: true, interrupted: false } }
    ]
    const runtime = new FakeRuntime(WAIT, { orchestrator: asking })
    const { engine, a } = await two(runtime)
    await engine.invoke('ticket.create', ticketInput('Alpha work', 'backlog'), a.id)
    await engine.invoke('orchestrator.send', 'Hello')
    await eventually(async () => expect((await engine.invoke('orchestrator.get')).status).toBe('idle'))
    await engine.invoke('orchestrator.send', 'Please start the alpha ticket')
    await eventually(async () => expect((await engine.invoke('orchestrator.get')).proposals).toHaveLength(1))
    const { proposals } = await engine.invoke('orchestrator.get')
    expect(proposals[0]).toMatchObject({ kind: 'start_lineup', workspaceId: a.id })
  })

  it('the drag and the button act on the ticket’s workspace even when another one is focused', async () => {
    const { engine, a } = await withOrchestrator()
    const t = await engine.invoke('ticket.create', ticketInput('Alpha work', 'backlog'), a.id)
    const proposal = await engine.invoke('ticket.proposeStart', t.id)
    expect(proposal.workspaceId).toBe(a.id)
  })

  it('starts the session again, resuming it, when a workspace is opened so its repo is readable', async () => {
    const { runtime, engine, say } = await withOrchestrator()
    await say('Hello')
    const third = await makeRepo('charlie')
    await engine.invoke('workspace.open', third)
    await say('And now?')
    await eventually(() => expect(runtime.orchestratorSpecs).toHaveLength(2))
    const second = runtime.orchestratorSpecs[1]!
    expect(second.additionalDirectories).toContain(third)
    expect(second.resumeSessionId).toBe('orch')
    // A planned relaunch is not a failure.
    const thread = await engine.invoke('orchestrator.get')
    expect(thread.events.some((e) => e.event.kind === 'process_exit')).toBe(false)
    expect(thread.status).toBe('idle')
  })
})

describe('stuck detector and holds across workspaces', () => {
  const MIN = 60_000

  it('the stuck detector watches the agents of every workspace', async () => {
    const { FakeClock } = await import('./holds/clock')
    const clock = new FakeClock(new Date('2026-11-02T09:00:00.000Z'))
    const runtime = new FakeRuntime(WAIT)
    const engine = await makeEngine(runtime, { clock, stuck: { timer: clock, newestChange: async () => null } })
    const a = await engine.invoke('workspace.open', await makeRepo('alpha'))
    const b = await engine.invoke('workspace.open', await makeRepo('bravo'))
    const inA = await engine.invoke('ticket.create', ticketInput('Alpha'), a.id)
    const inB = await engine.invoke('ticket.create', ticketInput('Bravo'), b.id)
    await engine.invoke('agent.start', inA.id)
    await engine.invoke('agent.start', inB.id)
    await runtime.started(2)
    expect(runtime.specs).toHaveLength(2)
    await eventually(async () => {
      for (const id of [inA.id, inB.id]) {
        expect((await engine.invoke('thread.get', id)).events.some((e) => e.event.kind === 'session')).toBe(true)
      }
    })

    await clock.advance(10 * MIN)
    // The focused workspace is B; A's board is read by id.
    expect((await engine.invoke('board.get', a.id)).tickets[0]!.stuck).toMatchObject({ rule: 'silence' })
    expect((await engine.invoke('board.get', b.id)).tickets[0]!.stuck).toMatchObject({ rule: 'silence' })
  })

  it('holds belong to their ticket’s workspace, and removing the workspace releases them', async () => {
    const { engine, a, b } = await two()
    const inA = await engine.invoke('ticket.create', ticketInput('Alpha'), a.id)
    const inB = await engine.invoke('ticket.create', ticketInput('Bravo'), b.id)
    await engine.invoke('ticket.hold', inA.id)
    await engine.invoke('ticket.hold', inB.id)
    expect((await engine.invoke('board.get', a.id)).tickets[0]!.hold).not.toBeNull()
    expect((await engine.invoke('board.get', b.id)).tickets[0]!.hold).not.toBeNull()

    await engine.invoke('workspace.remove', a.id)
    const back = await engine.invoke('workspace.open', a.repoPath)
    expect((await engine.invoke('board.get', back.id)).tickets[0]!.hold).toBeNull()
    expect((await engine.invoke('board.get', b.id)).tickets[0]!.hold).not.toBeNull()
  })
})

describe('workspace summaries for the rail', () => {
  it('counts what needs you in each workspace, flags working agents, and lists no removed workspace', async () => {
    const request: FakeStep[] = [
      { emit: { kind: 'session', sessionId: 's' } },
      { requestPermission: { toolName: 'Bash', input: { command: 'npm install zod' }, toolUseId: 'tool-1' } },
      { waitForSend: true }
    ]
    const runtime = new FakeRuntime([...request])
    const { engine, a, b } = await two(runtime)
    expect((await engine.invoke('workspace.summaries')).map((w) => [w.name, w.active, w.needsYou])).toEqual([
      ['alpha', false, 0],
      ['bravo', false, 0]
    ])

    // B is focused; the decision is in A.
    const inA = await engine.invoke('ticket.create', ticketInput('Alpha', 'backlog'), a.id)
    await engine.invoke('agent.start', inA.id)
    await eventually(async () => expect((await engine.invoke('thread.get', inA.id)).decisions).toHaveLength(1))
    await eventually(async () => {
      const summaries = await engine.invoke('workspace.summaries')
      expect(summaries.find((w) => w.id === a.id)).toMatchObject({ needsYou: 1 })
      expect(summaries.find((w) => w.id === b.id)).toMatchObject({ needsYou: 0, active: false })
    })

    await engine.invoke('agent.stop', inA.id)
    await engine.invoke('workspace.remove', a.id)
    expect((await engine.invoke('workspace.summaries')).map((w) => w.id)).toEqual([b.id])
  })

  it('shows a working agent as active', async () => {
    const { engine, a } = await two(new FakeRuntime(WAIT))
    const inA = await engine.invoke('ticket.create', ticketInput('Alpha', 'backlog'), a.id)
    await engine.invoke('agent.start', inA.id)
    await eventually(async () =>
      expect((await engine.invoke('workspace.summaries')).find((w) => w.id === a.id)).toMatchObject({ active: true, needsYou: 0 })
    )
  })
})

describe('the base branch warning on add', () => {
  // A repo whose only branch is a feature branch: no default branch to suggest, so the checkout is the base.
  async function featureOnlyRepo(name: string): Promise<string> {
    const repo = await makeRepo(name)
    await git(['branch', '-m', 'main', 'fm/feature'], repo)
    return repo
  }

  it('warns about a removed workspace coming back with a feature-branch base, and not about a live one', async () => {
    const engine = await makeEngine(new FakeRuntime(WAIT))
    const repo = await featureOnlyRepo('warned')
    const ws = await engine.invoke('workspace.open', repo)
    expect(ws.baseBranch).toBe('fm/feature')

    // Live: adding it again only focuses it, so there is nothing to warn about.
    const live = await engine.invoke('workspace.check', repo)
    expect(live.baseWarning).toBeUndefined()
    expect(live.base).toBeDefined()

    await engine.invoke('workspace.remove', ws.id)
    const check = await engine.invoke('workspace.check', repo)
    expect(check.baseWarning).toEqual({ branch: 'fm/feature', notOnRemote: false, restored: true })
    expect((await engine.invoke('workspace.open', repo)).baseBranch).toBe('fm/feature')
  })

  it("doesn't warn about a removed workspace whose base is main, whatever the checkout is on now", async () => {
    const engine = await makeEngine(new FakeRuntime(WAIT))
    const repo = await makeRepo('fine')
    const ws = await engine.invoke('workspace.open', repo)
    await engine.invoke('workspace.remove', ws.id)
    await git(['switch', '-c', 'fm/x'], repo)
    const check = await engine.invoke('workspace.check', repo)
    expect(check.baseWarning).toBeUndefined()
    expect(check.base?.removed).toEqual({ baseBranch: 'main', exists: true })
  })

  it('warns about a new folder whose base would be a feature branch, and gives the base choice too', async () => {
    const engine = await makeEngine(new FakeRuntime(WAIT))
    const repo = await featureOnlyRepo('fresh')
    const check = await engine.invoke('workspace.check', repo)
    expect(check.baseWarning).toEqual({ branch: 'fm/feature', notOnRemote: false, restored: false })
    expect(check.base).toMatchObject({ current: 'fm/feature', suggested: 'fm/feature', removed: null })
  })

  it("doesn't warn when the checkout is a feature branch but the default branch is the suggested base", async () => {
    const engine = await makeEngine(new FakeRuntime(WAIT))
    const repo = await makeRepo('offmain')
    await git(['switch', '-c', 'fm/x'], repo)
    const check = await engine.invoke('workspace.check', repo)
    expect(check.baseWarning).toBeUndefined()
    expect(check.base).toMatchObject({ current: 'fm/x', suggested: 'main' })
  })
})

describe('rail badge', () => {
  const badgeOf = async (engine: Engine, id: string) =>
    (await engine.invoke('workspace.summaries')).find((w) => w.id === id)!

  it('saves a label and a colour, and keeps them over a restart and over removing and re-adding the repo', async () => {
    const { engine, repoA, a } = await two()
    expect(await badgeOf(engine, a.id)).toMatchObject({ railLabel: null, railColor: null })
    await engine.invoke('workspace.setRailBadge', { label: '🚀', color: 'pink' }, a.id)
    expect(await badgeOf(engine, a.id)).toMatchObject({ railLabel: '🚀', railColor: 'pink' })

    await engine.dispose()
    const again = await makeEngine(new FakeRuntime(WAIT))
    expect(await badgeOf(again, a.id)).toMatchObject({ railLabel: '🚀', railColor: 'pink' })

    await again.invoke('workspace.remove', a.id)
    const back = await again.invoke('workspace.open', repoA)
    expect(back.id).toBe(a.id)
    expect(await badgeOf(again, a.id)).toMatchObject({ railLabel: '🚀', railColor: 'pink' })
  })

  it('refuses a label another workspace shows, as its own or automatic one, in any case', async () => {
    const { engine, a, b } = await two()
    // bravo shows BR automatically.
    await expect(engine.invoke('workspace.setRailBadge', { label: 'br' }, a.id)).rejects.toThrow(/bravo already shows BR/)
    await engine.invoke('workspace.setRailBadge', { label: 'Zz' }, b.id)
    await expect(engine.invoke('workspace.setRailBadge', { label: 'zZ' }, a.id)).rejects.toThrow(/already shows Zz/)
    await expect(engine.invoke('workspace.setRailBadge', { label: 'abcd' }, a.id)).rejects.toThrow(/at most 3/)
    expect(await badgeOf(engine, a.id)).toMatchObject({ railLabel: null })
  })

  it('clears with an empty string or null, and leaves what is left out as it is', async () => {
    const { engine, a } = await two()
    await engine.invoke('workspace.setRailBadge', { label: 'QQ', color: 'teal' }, a.id)
    await engine.invoke('workspace.setRailBadge', { label: '' }, a.id)
    expect(await badgeOf(engine, a.id)).toMatchObject({ railLabel: null, railColor: 'teal' })
    await engine.invoke('workspace.setRailBadge', { color: null }, a.id)
    expect(await badgeOf(engine, a.id)).toMatchObject({ railLabel: null, railColor: null })
  })

  it('refuses a colour outside the palette', async () => {
    const { engine, a } = await two()
    await expect(
      engine.invoke('workspace.setRailBadge', { color: 'red' } as never, a.id)
    ).rejects.toThrow()
    expect(await badgeOf(engine, a.id)).toMatchObject({ railColor: null })
  })

  it('on re-adding, drops a label another workspace took meanwhile but keeps the colour', async () => {
    const { engine, repoA, a, b } = await two()
    await engine.invoke('workspace.setRailBadge', { label: 'XY', color: 'lime' }, a.id)
    await engine.invoke('workspace.remove', a.id)
    await engine.invoke('workspace.setRailBadge', { label: 'xy' }, b.id)
    await engine.invoke('workspace.open', repoA)
    expect(await badgeOf(engine, a.id)).toMatchObject({ railLabel: null, railColor: 'lime' })
    expect(await badgeOf(engine, b.id)).toMatchObject({ railLabel: 'xy' })
  })
})
