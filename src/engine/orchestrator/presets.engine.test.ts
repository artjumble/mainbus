import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Ticket } from '../../shared/domain'
import { runGit } from '../git/git'
import { resolveHome, type HomePaths } from '../home'
import { createEngine, type Engine } from '../index'
import { makeRepo } from '../intake/testBoard'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import type { ExecFn } from '../runtime/resolveClaude'
import { eventually } from '../testWait'

// Each test starts an engine over a real repository: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-orch-presets-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  engines = []
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** A session whose first turn stays open, so its tools can be called in it. */
const OPEN_TURN: FakeStep[] = [{ emit: { kind: 'session', sessionId: 'orch' } }, { waitForSend: true }]

async function makeEngine(): Promise<{ engine: Engine; runtime: FakeRuntime }> {
  const runtime = new FakeRuntime([], { orchestrator: OPEN_TURN })
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec })
  engines.push(engine)
  await engine.invoke('workspace.open', repoPath)
  return { engine, runtime }
}

const newTicket = (engine: Engine): Promise<Ticket> =>
  engine.invoke('ticket.create', { title: 'Login', intent: 'Add a login form', spec: '', criteria: [], labels: [], column: 'backlog' })

async function liveTools(engine: Engine, runtime: FakeRuntime, first = 'Hello') {
  await engine.invoke('orchestrator.send', first)
  await eventually(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
  return runtime.orchestratorSpecs[0]!.tools
}

const ticketOf = async (engine: Engine, id: string) => (await engine.invoke('board.get')).tickets.find((t) => t.id === id)!

describe('create_tickets with a preset', () => {
  test('gives the ticket the preset settings and tells the orchestrator which preset each got', async () => {
    const { engine, runtime } = await makeEngine()
    const tools = await liveTools(engine, runtime, 'Document the API, then fix the typo')
    const answer = await tools.createTickets({ tickets: [{ title: 'Docs', preset: 'Docs' }, { title: 'Typo', preset: 'quick fix' }, { title: 'Plain' }] })
    expect(answer).toContain('#1 "Docs" (Docs preset), #2 "Typo" (quick fix preset) and #3 "Plain"')
    expect(answer).toContain('which preset each ticket got')
    const board = (await engine.invoke('board.get')).tickets
    const byTitle = (title: string) => board.find((t) => t.title === title)!
    expect(byTitle('Docs').runSettings?.excludedRoleIds).toHaveLength(2)
    expect(byTitle('Typo').runSettings?.excludedRoleIds).toHaveLength(1)
    expect(byTitle('Plain').runSettings).toBeNull()
  })

  test('an unknown preset refuses the whole call, creating nothing', async () => {
    const { engine, runtime } = await makeEngine()
    const tools = await liveTools(engine, runtime)
    const answer = await tools.createTickets({ tickets: [{ title: 'A' }, { title: 'B', preset: 'Nope' }] })
    expect(answer).toContain('tickets.1.preset: there is no preset "Nope" in repo; its presets are Full, Quick fix, Docs')
    expect(answer).toContain('Nothing was created')
    expect((await engine.invoke('board.get')).tickets).toEqual([])
  })
})

describe('update_ticket with a preset', () => {
  test('sets the ticket run settings, shows them in the receipt, and Undo puts the old ones back', async () => {
    const { engine, runtime } = await makeEngine()
    const t = await newTicket(engine)
    const tools = await liveTools(engine, runtime)

    const answer = await tools.updateTicket({ ticket: 1, preset: 'Docs' })
    expect(answer).toBe('Updated #1 "Login" in repo: run settings. The user can Undo it. Tell the user what changed.')
    const after = await ticketOf(engine, t.id)
    expect(after.runSettings?.roles).toEqual({ [Object.keys(after.runSettings!.roles)[0]!]: { model: 'sonnet', effort: 'medium' } })
    expect(after.runSettings?.excludedRoleIds).toHaveLength(2)

    const [edit] = (await engine.invoke('orchestrator.get')).edits
    expect(edit).toMatchObject({ fields: ['runSettings'], before: { runSettings: null }, after: { preset: 'Docs' } })

    await engine.invoke('ticket.undoEdit', edit!.id)
    expect((await ticketOf(engine, t.id)).runSettings).toBeNull()
  })

  test('Undo restores settings the user had saved, not the lineup defaults', async () => {
    const { engine, runtime } = await makeEngine()
    const t = await newTicket(engine)
    const lineup = await engine.invoke('lineup.get')
    const saved = await engine.invoke('ticket.setRunSettings', t.id, { excludedRoleIds: [lineup[2]!.id], roles: {}, extraInstructions: '' })
    const tools = await liveTools(engine, runtime)

    await tools.updateTicket({ ticket: 1, preset: 'Docs' })
    const [edit] = (await engine.invoke('orchestrator.get')).edits
    expect(edit!.before.runSettings).toEqual(saved.runSettings)
    await engine.invoke('ticket.undoEdit', edit!.id)
    expect((await ticketOf(engine, t.id)).runSettings).toEqual(saved.runSettings)
  })

  test('a preset the ticket already has changes nothing; an unknown name is refused', async () => {
    const { engine, runtime } = await makeEngine()
    const t = await newTicket(engine)
    const tools = await liveTools(engine, runtime)
    await tools.updateTicket({ ticket: 1, preset: 'Docs' })
    expect(await tools.updateTicket({ ticket: 1, preset: 'Docs' })).toContain('Nothing to change')
    expect(await tools.updateTicket({ ticket: 1, preset: 'Nope' })).toContain('there is no preset "Nope" in repo; its presets are Full, Quick fix, Docs')
    expect((await engine.invoke('orchestrator.get')).edits).toHaveLength(1)
    expect((await ticketOf(engine, t.id)).runSettings).not.toBeNull()
  })

  test('Full resets the ticket to the lineup defaults, and the receipt says so', async () => {
    const { engine, runtime } = await makeEngine()
    const t = await newTicket(engine)
    const tools = await liveTools(engine, runtime)
    await tools.updateTicket({ ticket: 1, preset: 'Docs' })
    await tools.updateTicket({ ticket: 1, preset: 'Full' })
    expect((await ticketOf(engine, t.id)).runSettings).toBeNull()
    expect((await engine.invoke('orchestrator.get')).edits.at(-1)).toMatchObject({ fields: ['runSettings'], after: { runSettings: null, preset: 'Full' } })
  })

  test('is refused for an Investigate ticket', async () => {
    const { engine, runtime } = await makeEngine()
    await engine.invoke('ticket.create', { title: 'Why', intent: 'Look into it', spec: '', criteria: [], labels: [], column: 'backlog', kind: 'investigate' })
    const tools = await liveTools(engine, runtime)
    expect(await tools.updateTicket({ ticket: 1, preset: 'Docs' })).toContain('presets are for Change tickets')
  })
})

describe('the read tools list the presets', () => {
  test('list_workspaces and get_ticket name them, with what each runs', async () => {
    const { engine, runtime } = await makeEngine()
    await newTicket(engine)
    const tools = await liveTools(engine, runtime)
    expect(await tools.listWorkspaces()).toContain('presets: Full, Quick fix, Docs')
    const ticket = await tools.getTicket({ number: 1 })
    expect(ticket).toContain('## Presets')
    expect(ticket).toContain('- Quick fix: Implementer, Reviewer')
    // Labelled with the version the fake's `sonnet` alias names.
    expect(ticket).toContain('- Docs: Implementer · Implementer on Sonnet 5.5, medium')
  })
})
