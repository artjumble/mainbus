import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { EngineEvent } from '../../shared/api'
import { ALIAS_FALLBACK } from '../../shared/orchestratorModel'
import { runGit } from '../git/git'
import { resolveHome, type HomePaths } from '../home'
import { createEngine, type Engine } from '../index'
import { makeRepo } from '../intake/testBoard'
import { FAKE_SUPPORTED_MODELS, FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import type { ExecFn } from '../runtime/resolveClaude'
import type { AgentRuntime } from '../runtime/types'
import { eventually } from '../testWait'
import { OrchestratorModels } from './models'

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-orchestrator-model-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  engines = []
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function makeEngine(runtime: AgentRuntime | null): Promise<{ engine: Engine; events: EngineEvent[] }> {
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec })
  engines.push(engine)
  await engine.invoke('workspace.open', repoPath)
  const events: EngineEvent[] = []
  engine.on((e) => events.push(e))
  return { engine, events }
}

const say = (text: string): FakeStep => ({ emit: { kind: 'message', text } })
const turnEnd: FakeStep = { emit: { kind: 'turn_end', ok: true } }
const session: FakeStep = { emit: { kind: 'session', sessionId: 'sess-1' } }

async function status(engine: Engine) {
  return (await engine.invoke('orchestrator.get')).status
}

describe('the model list', () => {
  test("comes from the binary once per launch, in the orchestrator's folder: the latest Fable, Opus and Sonnet, Opus at medium by default", async () => {
    const runtime = new FakeRuntime([])
    const { engine } = await makeEngine(runtime)
    const state = await engine.invoke('orchestrator.model')
    expect(state.options.map((o) => [o.family, o.model, o.label])).toEqual([
      ['fable', 'claude-fable-5-2', 'Fable 5.2'],
      ['opus', 'opus', 'Opus 5.5'],
      ['sonnet', 'sonnet', 'Sonnet 5.5']
    ])
    expect(state).toMatchObject({ fromBinary: true, saved: 'opus', current: { model: 'opus', label: 'Opus 5.5' }, effort: 'medium', notice: null })
    await engine.invoke('orchestrator.model')
    await engine.invoke('settings.setOrchestratorEffort', 'low')
    expect(runtime.modelListReads).toEqual([path.join(paths.root, 'orchestrator')])
  })

  test('falls back to the aliases when the list cannot be read, and then refuses a family they lack', async () => {
    const runtime = new FakeRuntime([], { supportedModels: { fail: 'claude crashed' } })
    const { engine } = await makeEngine(runtime)
    const state = await engine.invoke('orchestrator.model')
    expect(state).toMatchObject({ options: ALIAS_FALLBACK, fromBinary: false, current: { model: 'opus', label: 'Opus' } })
    await expect(engine.invoke('settings.setOrchestratorModel', 'fable')).rejects.toThrow("Fable isn't offered by your claude")
    expect((await engine.invoke('settings.get')).orchestratorModel).toBe('opus')
    await expect(engine.invoke('settings.setOrchestratorModel', 'haiku' as 'opus')).rejects.toThrow("The orchestrator's model must be")
    expect((await engine.invoke('settings.setOrchestratorModel', 'sonnet')).orchestratorModel).toBe('sonnet')
  })

  test('without a runtime, the aliases stand in', async () => {
    const { engine } = await makeEngine(null)
    expect(await engine.invoke('orchestrator.model')).toMatchObject({ options: ALIAS_FALLBACK, fromBinary: false })
  })

  test('the cache reads once, and a list with nothing usable falls back too', async () => {
    let reads = 0
    const models = new OrchestratorModels(async () => {
      reads++
      return [{ value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5' }]
    })
    expect(await models.load()).toEqual({ options: ALIAS_FALLBACK, fromBinary: false })
    await models.state({ orchestratorModel: 'opus', orchestratorEffort: 'high' })
    expect(reads).toBe(1)
  })

  test('a saved model that is no longer offered falls back to Opus with a notice, and the launch uses Opus', async () => {
    const { engine: first } = await makeEngine(new FakeRuntime([]))
    await first.invoke('settings.setOrchestratorModel', 'fable')
    await first.dispose()

    const withoutFable = FAKE_SUPPORTED_MODELS.filter((m) => !(m.resolvedModel ?? m.value).includes('fable'))
    const runtime = new FakeRuntime([], { supportedModels: withoutFable, orchestrator: [say('Hi'), turnEnd] })
    const { engine } = await makeEngine(runtime)
    const state = await engine.invoke('orchestrator.model')
    expect(state).toMatchObject({ saved: 'fable', current: { family: 'opus', model: 'opus' } })
    expect(state.notice).toBe("Fable isn't offered by your claude, so the orchestrator uses Opus 5.5.")
    // The saved choice is kept: if the binary offers Fable again, it comes back.
    expect((await engine.invoke('settings.get')).orchestratorModel).toBe('fable')
    await engine.invoke('orchestrator.send', 'Hello')
    await eventually(async () => expect(await status(engine)).toBe('idle'))
    expect(runtime.orchestratorSpecs[0]).toMatchObject({ model: 'opus', effort: 'medium' })
  })

  test('a change of model or effort tells the panel', async () => {
    const { engine, events } = await makeEngine(new FakeRuntime([]))
    await engine.invoke('settings.setOrchestratorModel', 'fable')
    await engine.invoke('settings.setOrchestratorEffort', 'xhigh')
    const told = events.flatMap((e) => (e.type === 'orchestrator.model' ? [e.state] : []))
    expect(told.at(-2)).toMatchObject({ current: { label: 'Fable 5.2' }, effort: 'medium' })
    expect(told.at(-1)).toMatchObject({ current: { label: 'Fable 5.2' }, effort: 'xhigh' })
  })
})

describe('the chosen model and effort', () => {
  test('the launch uses them', async () => {
    const runtime = new FakeRuntime([], { orchestrator: [{ expectModel: { model: 'claude-fable-5-2', effort: 'max' } }, say('Hi'), turnEnd] })
    const { engine } = await makeEngine(runtime)
    await engine.invoke('settings.setOrchestratorModel', 'fable')
    await engine.invoke('settings.setOrchestratorEffort', 'max')
    await engine.invoke('orchestrator.send', 'Hello')
    await eventually(async () => expect(await status(engine)).toBe('idle'))
    expect(runtime.orchestratorSpecs[0]).toMatchObject({ model: 'claude-fable-5-2', effort: 'max' })
    expect((await engine.invoke('orchestrator.get')).events.map((e) => e.event.kind)).not.toContain('error')
  })

  test('a change between turns applies from the next turn, in the same session and conversation', async () => {
    const runtime = new FakeRuntime([], {
      orchestrator: [
        session,
        { expectModel: { model: 'opus', effort: 'medium' } },
        say('First'),
        turnEnd,
        { waitForSend: true },
        { expectModel: { model: 'sonnet', effort: 'high' } },
        say('Second'),
        turnEnd
      ]
    })
    const { engine } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'One')
    await eventually(async () => expect(await status(engine)).toBe('idle'))
    await engine.invoke('settings.setOrchestratorModel', 'sonnet')
    await engine.invoke('settings.setOrchestratorEffort', 'high')
    expect(runtime.modelChanges).toEqual([])

    await engine.invoke('orchestrator.send', 'Two')
    await eventually(async () => expect(await status(engine)).toBe('idle'))
    expect(runtime.modelChanges).toEqual([{ run: 'fake-1', model: 'sonnet', effort: 'high' }])
    expect(runtime.orchestratorSpecs).toHaveLength(1)
    const thread = await engine.invoke('orchestrator.get')
    expect(thread.runs).toHaveLength(1)
    expect(thread.events.map((e) => e.event)).toContainEqual({ kind: 'message', text: 'Second' })
    expect(thread.events.map((e) => e.event.kind)).not.toContain('error')

    // No change, no call.
    await expect(engine.invoke('orchestrator.send', 'Three')).resolves.toBeUndefined()
    expect(runtime.modelChanges).toHaveLength(1)
  })

  test('a change during a turn leaves the turn alone and applies from the next one', async () => {
    const runtime = new FakeRuntime([], {
      endTurnOnInterrupt: true,
      orchestrator: [session, say('Thinking'), { waitForSend: true }, { expectModel: { model: 'claude-fable-5-2', effort: 'low' } }, say('Later'), turnEnd]
    })
    const { engine } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'Think hard')
    expect(await status(engine)).toBe('working')
    await engine.invoke('settings.setOrchestratorModel', 'fable')
    await engine.invoke('settings.setOrchestratorEffort', 'low')
    expect(runtime.modelChanges).toEqual([])
    expect(runtime.interrupted).toEqual([])
    expect(await status(engine)).toBe('working')

    // The user ends this turn; the next one runs on Fable at low effort, in the same session.
    await engine.invoke('orchestrator.stop')
    await eventually(async () => expect(await status(engine)).toBe('idle'))
    await engine.invoke('orchestrator.send', 'Go on')
    await eventually(async () => expect(await status(engine)).toBe('idle'))
    expect(runtime.modelChanges).toEqual([{ run: 'fake-1', model: 'claude-fable-5-2', effort: 'low' }])
    expect(runtime.orchestratorSpecs).toHaveLength(1)
    expect((await engine.invoke('orchestrator.get')).events.map((e) => e.event)).toContainEqual({ kind: 'message', text: 'Later' })
  })

  test("when the live session can't change its model, the next turn resumes the same conversation with the new one", async () => {
    const runtime = new FakeRuntime([], {
      setModelEffortFails: 'not supported',
      orchestrator: (spec) =>
        spec.resumeSessionId
          ? [{ expectModel: { model: 'sonnet', effort: 'max' } }, say('Resumed on Sonnet'), turnEnd]
          : [session, say('First'), turnEnd, { waitForSend: true }, say('Should not be reached'), turnEnd]
    })
    const { engine } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'One')
    await eventually(async () => expect(await status(engine)).toBe('idle'))
    await engine.invoke('settings.setOrchestratorModel', 'sonnet')
    await engine.invoke('settings.setOrchestratorEffort', 'max')
    await engine.invoke('orchestrator.send', 'Two')
    await eventually(async () => expect(await status(engine)).toBe('idle'))

    expect(runtime.orchestratorSpecs.map((s) => [s.resumeSessionId, s.model, s.effort])).toEqual([
      [undefined, 'opus', 'medium'],
      ['sess-1', 'sonnet', 'max']
    ])
    expect(runtime.orchestratorSpecs[1]!.prompt).toMatch(/\n\nTwo$/)
    const thread = await engine.invoke('orchestrator.get')
    expect(thread.runs).toHaveLength(1)
    const kinds = thread.events.map((e) => e.event)
    expect(kinds).toContainEqual({ kind: 'message', text: 'Resumed on Sonnet' })
    expect(kinds.map((k) => k.kind)).not.toContain('error')
    expect(kinds.map((k) => k.kind)).not.toContain('process_exit')
  })
})
