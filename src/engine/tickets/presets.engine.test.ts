import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
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
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-presets-'))
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

const newTicket = (engine: Engine, extra: { preset?: string; kind?: 'change' | 'investigate'; column?: 'backlog' | 'ready' } = {}) =>
  engine.invoke('ticket.create', { title: 'Docs', intent: 'Document it', spec: '', criteria: [], labels: [], column: extra.column ?? 'backlog', ...extra })

const boardTicket = async (engine: Engine, id: string) => (await engine.invoke('board.get')).tickets.find((t) => t.id === id)!

const roleIds = async (engine: Engine): Promise<Record<string, string>> =>
  Object.fromEntries((await engine.invoke('lineup.get')).map((r) => [r.name, r.id]))

describe('preset.list, preset.save and preset.remove', () => {
  test('a workspace has Full, Quick fix and Docs; adding, renaming, editing and removing work', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    const listed = await engine.invoke('preset.list')
    expect(listed.map((p) => p.name)).toEqual(['Full', 'Quick fix', 'Docs'])
    const id = await roleIds(engine)

    const added = await engine.invoke('preset.save', {
      name: 'Opus only',
      settings: { excludedRoleIds: [id['Planner']!], roles: { [id['Implementer']!]: { model: 'opus' } }, extraInstructions: '  Careful.  ' }
    })
    expect(added.settings).toEqual({
      excludedRoleIds: [id['Planner']],
      roles: { [id['Implementer']!]: { model: 'opus' } },
      extraInstructions: 'Careful.',
      roleNames: { [id['Planner']!]: 'Planner', [id['Implementer']!]: 'Implementer' }
    })
    const renamed = await engine.invoke('preset.save', { id: added.id, name: 'Opus', settings: { excludedRoleIds: [], roles: {}, extraInstructions: '' } })
    expect(renamed).toMatchObject({ id: added.id, name: 'Opus', settings: { excludedRoleIds: [], extraInstructions: null } })
    expect((await engine.invoke('preset.list')).map((p) => p.name)).toEqual(['Full', 'Quick fix', 'Docs', 'Opus'])

    await engine.invoke('preset.remove', added.id)
    expect((await engine.invoke('preset.list')).map((p) => p.name)).toEqual(['Full', 'Quick fix', 'Docs'])
  })

  test.each([
    [{ name: 'X', settings: { excludedRoleIds: ['nope'], roles: {}, extraInstructions: '' } }, 'There is no role "nope" in this lineup'],
    [{ name: 'X', settings: { excludedRoleIds: [], roles: { nope: { model: 'opus' } }, extraInstructions: '' } }, 'There is no role "nope" in this lineup'],
    [{ name: 'X', settings: { excludedRoleIds: [], roles: {}, extraInstructions: 'x'.repeat(10_001) } }, 'at most 10000 characters'],
    [{ name: '  ', settings: { excludedRoleIds: [], roles: {}, extraInstructions: '' } }, 'A preset needs a name.'],
    [{ name: 'docs', settings: { excludedRoleIds: [], roles: {}, extraInstructions: '' } }, 'already a preset called "docs"']
  ])('refuses %j', async (preset, message) => {
    const engine = await makeEngine(new FakeRuntime([]))
    await expect(engine.invoke('preset.save', preset)).rejects.toThrow(message)
    expect(await engine.invoke('preset.list')).toHaveLength(3)
  })

  test('refuses leaving every role out, and a model the lineup does not allow', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    const id = await roleIds(engine)
    await expect(
      engine.invoke('preset.save', { name: 'None', settings: { excludedRoleIds: Object.values(id), roles: {}, extraInstructions: '' } })
    ).rejects.toThrow('At least one role must run')
    await expect(
      engine.invoke('preset.save', { name: 'Bad', settings: { excludedRoleIds: [], roles: { [id['Planner']!]: { model: 'gpt-4' } }, extraInstructions: '' } })
    ).rejects.toThrow('Planner has an unknown model')
  })
})

describe('ticket.create with a preset', () => {
  test("Docs gives the ticket its own settings: no Planner or Reviewer, the Implementer on Sonnet at medium effort", async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    const id = await roleIds(engine)
    const t = await newTicket(engine, { preset: 'Docs' })
    expect(t.runSettings).toEqual({
      excludedRoleIds: [id['Planner']!, id['Reviewer']!],
      roles: { [id['Implementer']!]: { model: 'sonnet', effort: 'medium' } },
      extraInstructions: null,
      roleNames: { [id['Planner']!]: 'Planner', [id['Implementer']!]: 'Implementer', [id['Reviewer']!]: 'Reviewer' }
    })
    expect((await boardTicket(engine, t.id)).runSettings).toEqual(t.runSettings)
  })

  test('the name is matched ignoring case; Full stores nothing, so the card shows no custom run', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    const quick = await newTicket(engine, { preset: ' quick FIX ' })
    expect(quick.runSettings?.excludedRoleIds).toHaveLength(1)
    expect((await newTicket(engine, { preset: 'Full' })).runSettings).toBeNull()
    expect((await newTicket(engine)).runSettings).toBeNull()
  })

  test('a later edit or removal of the preset leaves the ticket as it was', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    const id = await roleIds(engine)
    const t = await newTicket(engine, { preset: 'Docs' })
    const before = t.runSettings
    const docs = (await engine.invoke('preset.list')).find((p) => p.name === 'Docs')!
    await engine.invoke('preset.save', {
      id: docs.id,
      name: 'Docs',
      settings: { excludedRoleIds: [id['Reviewer']!], roles: { [id['Implementer']!]: { model: 'opus' } }, extraInstructions: 'Changed.' }
    })
    expect((await boardTicket(engine, t.id)).runSettings).toEqual(before)
    await engine.invoke('preset.remove', docs.id)
    expect((await boardTicket(engine, t.id)).runSettings).toEqual(before)
  })

  test('an unknown name is refused and creates nothing; so is a preset on an Investigate ticket', async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    await expect(newTicket(engine, { preset: 'Nope' })).rejects.toThrow('There is no preset "Nope"')
    await expect(newTicket(engine, { preset: 'Nope' })).rejects.toThrow('its presets are Full, Quick fix, Docs')
    await expect(newTicket(engine, { preset: 'Docs', kind: 'investigate' })).rejects.toThrow('Presets are for Change tickets')
    expect((await engine.invoke('board.get')).tickets).toEqual([])
  })

  test("a preset naming a role the lineup has lost is dropped, and the rest still applies", async () => {
    const engine = await makeEngine(new FakeRuntime([]))
    const lineup = await engine.invoke('lineup.get')
    // With the Planner gone from the lineup, the part of Quick fix that names it is dropped.
    await engine.invoke('lineup.save', lineup.filter((r) => r.name !== 'Planner'))
    const t = await newTicket(engine, { preset: 'Quick fix' })
    expect(t.runSettings).toBeNull()
    const docs = await newTicket(engine, { preset: 'Docs' })
    expect(docs.runSettings?.excludedRoleIds).toEqual([lineup.find((r) => r.name === 'Reviewer')!.id])
  })

  test('starting a Docs ticket runs only the Implementer, on Sonnet at medium effort', async () => {
    const runtime = new FakeRuntime(WORKING)
    const engine = await makeEngine(runtime)
    const t = await newTicket(engine, { preset: 'Docs', column: 'ready' })
    await engine.invoke('agent.start', t.id)
    await vi.waitFor(() => expect(runtime.specs).toHaveLength(1))
    expect(runtime.specs[0]).toMatchObject({ role: 'Implementer', model: 'sonnet', effort: 'medium' })
    expect((await boardTicket(engine, t.id)).lineup.map((r) => r.name)).toEqual(['Implementer'])
  })
})
