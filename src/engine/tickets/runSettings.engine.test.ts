import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { LineupRole } from '../../shared/domain'
import { runGit } from '../git/git'
import { resolveHome, type HomePaths } from '../home'
import { createEngine, type Engine } from '../index'
import { makeRepo } from '../intake/testBoard'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import type { ExecFn } from '../runtime/resolveClaude'

// Each test starts an engine over a real repository: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-run-settings-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  engines = []
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const WORKING: FakeStep[] = [{ emit: { kind: 'session', sessionId: 'role-sess' } }, { waitForSend: true }]

async function makeEngine(runtime: FakeRuntime): Promise<Engine> {
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec })
  engines.push(engine)
  await engine.invoke('workspace.open', repoPath)
  return engine
}

const newTicket = (engine: Engine, column: 'backlog' | 'ready' = 'backlog', kind: 'change' | 'investigate' = 'change') =>
  engine.invoke('ticket.create', { title: 'Login', intent: 'Add a login form', spec: '', criteria: [], labels: [], column, kind })

const boardTicket = async (engine: Engine, id: string) => (await engine.invoke('board.get')).tickets.find((t) => t.id === id)!

/** The Change lineup's role ids, by name. */
async function ids(engine: Engine): Promise<Record<string, string>> {
  return Object.fromEntries((await engine.invoke('lineup.get')).map((r) => [r.name, r.id]))
}

/** Leave out the Planner and put the Implementer on Opus, high. */
async function saveTypical(engine: Engine, ticketId: string) {
  const id = await ids(engine)
  return engine.invoke('ticket.setRunSettings', ticketId, {
    excludedRoleIds: [id['Planner']!],
    roles: { [id['Implementer']!]: { model: 'opus', effort: 'high' } },
    extraInstructions: '  Keep the diff small.  '
  })
}

describe('ticket.setRunSettings', () => {
  test('saves them on a Backlog ticket without starting it; the board carries them; null resets', async () => {
    const runtime = new FakeRuntime(WORKING)
    const engine = await makeEngine(runtime)
    const t = await newTicket(engine)
    const id = await ids(engine)

    const saved = await saveTypical(engine, t.id)
    expect(saved.runSettings).toEqual({
      excludedRoleIds: [id['Planner']],
      roles: { [id['Implementer']!]: { model: 'opus', effort: 'high' } },
      extraInstructions: 'Keep the diff small.',
      roleNames: { [id['Planner']!]: 'Planner', [id['Implementer']!]: 'Implementer' }
    })
    expect(await boardTicket(engine, t.id)).toMatchObject({ runSettings: saved.runSettings, runSettingsNotices: [], state: { column: 'backlog' } })
    expect(runtime.specs).toEqual([])

    expect((await engine.invoke('ticket.setRunSettings', t.id, null)).runSettings).toBeNull()
    expect((await boardTicket(engine, t.id)).runSettings).toBeNull()
  })

  test.each([
    [{ excludedRoleIds: ['nope'], roles: {}, extraInstructions: '' }, 'There is no role "nope" in this lineup'],
    [{ excludedRoleIds: [], roles: { nope: { model: 'opus' } }, extraInstructions: '' }, 'There is no role "nope" in this lineup'],
    [{ excludedRoleIds: [], roles: {}, extraInstructions: 'x'.repeat(10_001) }, 'at most 10000 characters']
  ])('refuses %j', async (input, message) => {
    const engine = await makeEngine(new FakeRuntime([]))
    const t = await newTicket(engine)
    await expect(engine.invoke('ticket.setRunSettings', t.id, input)).rejects.toThrow(message)
    expect((await boardTicket(engine, t.id)).runSettings).toBeNull()
  })

  test('refuses leaving every role out, and a model the lineup doesn’t allow', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    const t = await newTicket(engine)
    const id = await ids(engine)
    await expect(engine.invoke('ticket.setRunSettings', t.id, { excludedRoleIds: Object.values(id), roles: {}, extraInstructions: '' })).rejects.toThrow(
      'At least one role must run'
    )
    await expect(
      engine.invoke('ticket.setRunSettings', t.id, { excludedRoleIds: [], roles: { [id['Planner']!]: { model: 'gpt-4' } }, extraInstructions: '' })
    ).rejects.toThrow('Planner has an unknown model')
  })

  test('are read-only while a run is open, kept after Stop, and editable again in Ready', async () => {
    const engine = await makeEngine(new FakeRuntime(WORKING))
    const t = await newTicket(engine, 'ready')
    const saved = (await saveTypical(engine, t.id)).runSettings
    await engine.invoke('agent.start', t.id)
    await vi.waitFor(async () => expect((await boardTicket(engine, t.id)).state.agentStatus).toBe('working'))

    await expect(engine.invoke('ticket.setRunSettings', t.id, null)).rejects.toThrow("Run settings can't be changed while a run is open")
    expect((await boardTicket(engine, t.id)).runSettings).toEqual(saved)

    await engine.invoke('agent.stop', t.id)
    await vi.waitFor(async () => expect((await boardTicket(engine, t.id)).state.column).toBe('ready'))
    expect((await boardTicket(engine, t.id)).runSettings).toEqual(saved)
    expect((await engine.invoke('ticket.setRunSettings', t.id, null)).runSettings).toBeNull()
  })

  test("an Investigate ticket's settings are checked against the Investigate lineup", async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    const t = await newTicket(engine, 'backlog', 'investigate')
    const change = await ids(engine)
    const investigate = await engine.invoke('lineup.get', 'investigate')
    await expect(
      engine.invoke('ticket.setRunSettings', t.id, { excludedRoleIds: [], roles: { [change['Implementer']!]: { model: 'opus' } }, extraInstructions: '' })
    ).rejects.toThrow('There is no role')
    const saved = await engine.invoke('ticket.setRunSettings', t.id, {
      excludedRoleIds: [],
      roles: { [investigate[0]!.id]: { model: 'haiku' } },
      extraInstructions: ''
    })
    expect(saved.runSettings?.roles).toEqual({ [investigate[0]!.id]: { model: 'haiku' } })
  })
})

describe('every way of starting uses them', () => {
  test('Start (no options) runs only the saved roles, with the saved model, effort and instructions', async () => {
    const runtime = new FakeRuntime(WORKING)
    const engine = await makeEngine(runtime)
    const t = await newTicket(engine, 'ready')
    await saveTypical(engine, t.id)
    await engine.invoke('agent.start', t.id)
    await vi.waitFor(() => expect(runtime.specs).toHaveLength(1))
    expect(runtime.specs[0]).toMatchObject({ role: 'Implementer', model: 'opus', effort: 'high' })
    expect(runtime.specs[0]!.appendSystemPrompt).toContain('Keep the diff small.')
    expect((await boardTicket(engine, t.id)).lineup.map((r) => r.name)).toEqual(['Implementer', 'Reviewer'])
  })

  test('a start with its own options (Adjust before starting) uses those instead', async () => {
    const runtime = new FakeRuntime(WORKING)
    const engine = await makeEngine(runtime)
    const t = await newTicket(engine, 'ready')
    await saveTypical(engine, t.id)
    const id = await ids(engine)
    await engine.invoke('agent.start', t.id, { roleIds: [id['Planner']!], roles: { [id['Planner']!]: { model: 'haiku', effort: 'low' } } })
    await vi.waitFor(() => expect(runtime.specs).toHaveLength(1))
    expect(runtime.specs[0]).toMatchObject({ role: 'Planner', model: 'haiku', effort: 'low' })
  })

  test('unattended mode starts a Ready ticket with them', async () => {
    const runtime = new FakeRuntime(WORKING)
    const engine = await makeEngine(runtime)
    const t = await newTicket(engine, 'ready')
    await saveTypical(engine, t.id)
    await engine.invoke('unattended.set', true)
    await vi.waitFor(() => expect(runtime.specs).toHaveLength(1))
    expect(runtime.specs[0]).toMatchObject({ role: 'Implementer', model: 'opus', effort: 'high' })
    await engine.invoke('unattended.set', false)
  })

  test('a drag into In progress proposes them', async () => {
    const engine = await makeEngine(new FakeRuntime([{ waitForSend: true }], { orchestrator: [] }))
    const t = await newTicket(engine)
    await saveTypical(engine, t.id)
    const p = await engine.invoke('ticket.proposeStart', t.id)
    expect(p.payload).toMatchObject({
      roles: [
        { name: 'Implementer', model: 'opus', effort: 'high', source: 'user' },
        { name: 'Reviewer', model: 'opus', effort: 'medium' }
      ],
      extraInstructions: 'Keep the diff small.'
    })
  })
})

describe('when the lineup changes later', () => {
  test('a removed role is dropped with a notice on the board; a role added later runs', async () => {
    const runtime = new FakeRuntime(WORKING)
    const engine = await makeEngine(runtime)
    const t = await newTicket(engine, 'ready')
    const lineup = await engine.invoke('lineup.get')
    const reviewer = lineup.find((r) => r.name === 'Reviewer')!
    await engine.invoke('ticket.setRunSettings', t.id, {
      excludedRoleIds: [lineup.find((r) => r.name === 'Planner')!.id],
      roles: { [reviewer.id]: { model: 'haiku' } },
      extraInstructions: ''
    })

    // The Reviewer goes, a Tester comes.
    const input = (r: LineupRole) => ({ ...r, workspaceId: undefined, lineup: undefined, position: undefined })
    const tester = { ...input(reviewer), id: 'new-tester', name: 'Tester' }
    await engine.invoke('lineup.save', [...lineup.filter((r) => r.name !== 'Reviewer').map(input), tester] as never)
    expect((await boardTicket(engine, t.id)).runSettingsNotices).toEqual(['Reviewer is no longer in the lineup, so its saved setting was dropped.'])

    await engine.invoke('agent.start', t.id)
    await vi.waitFor(async () => expect((await boardTicket(engine, t.id)).lineup.map((r) => r.name)).toEqual(['Implementer', 'Tester']))
  })
})
