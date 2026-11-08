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

vi.setConfig({ testTimeout: 30_000 })

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

let tmp: string
let paths: HomePaths
let engine: Engine | undefined
let runtime: FakeRuntime

const turnEnd: FakeStep = { emit: { kind: 'turn_end', ok: true } }
const TURNS: FakeStep[] = [
  { emit: { kind: 'session', sessionId: 'sess-1' } },
  turnEnd,
  ...Array.from({ length: 4 }, () => [{ waitForSend: true }, turnEnd] as FakeStep[]).flat()
]

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-mentions-'))
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  runtime = new FakeRuntime([], { orchestrator: TURNS })
})

afterEach(async () => {
  await engine?.dispose()
  engine = undefined
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** An engine with `mainbus` focused and `hunter` open. */
async function start() {
  engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec })
  const mainbus = await engine.invoke('workspace.open', await makeRepo(path.join(tmp, 'mainbus')))
  const hunter = await engine.invoke('workspace.open', await makeRepo(path.join(tmp, 'hunter')))
  await engine.invoke('workspace.focus', mainbus.id)
  return { engine, mainbus, hunter }
}

const idle = (e: Engine) => vi.waitFor(async () => expect((await e.invoke('orchestrator.get')).status).toBe('idle'))
const userEvents = async (e: Engine) =>
  (await e.invoke('orchestrator.get')).events.map((x) => x.event).filter((x) => x.kind === 'user_message')

describe('orchestrator.send with mentions', () => {
  test('picked ids are resolved, stored with the message, and named in the header', async () => {
    const { engine: e, hunter } = await start()
    await e.invoke('orchestrator.send', 'create a ticket in @hunter for X', undefined, [hunter.id])
    await idle(e)

    expect(await userEvents(e)).toEqual([
      {
        kind: 'user_message',
        text: 'create a ticket in @hunter for X',
        mentions: [{ token: '@hunter', workspaceId: hunter.id, name: 'hunter' }]
      }
    ])
    const lines = runtime.orchestratorSpecs[0]!.prompt.split('\n')
    expect(lines[0]).toContain('Focused workspace: mainbus')
    expect(lines[1]).toBe(`[Mainbus] Mentioned workspaces: hunter (id ${hunter.id}, ${hunter.repoPath})`)
    expect(lines.slice(2)).toEqual(['', 'create a ticket in @hunter for X'])
  })

  test('a hand-typed exact name resolves, and an unknown one is marked', async () => {
    const { engine: e, hunter } = await start()
    await e.invoke('orchestrator.send', 'compare @Hunter with @nobody')
    await idle(e)
    const prompt = runtime.orchestratorSpecs[0]!.prompt
    expect(prompt).toContain(`hunter (id ${hunter.id}, ${hunter.repoPath}); "@nobody" (not a workspace)`)
    const [message] = await userEvents(e)
    expect(message).toMatchObject({ mentions: [{ token: '@Hunter', workspaceId: hunter.id, name: 'hunter' }] })
  })

  test('no mentions: no line and no field', async () => {
    const { engine: e } = await start()
    await e.invoke('orchestrator.send', 'hello', undefined, [])
    await idle(e)
    expect(runtime.orchestratorSpecs[0]!.prompt).not.toContain('Mentioned workspaces')
    expect(await userEvents(e)).toEqual([{ kind: 'user_message', text: 'hello' }])
  })

  test('bad mentions input is rejected', async () => {
    const { engine: e } = await start()
    await expect(e.invoke('orchestrator.send', 'hi', undefined, 'w1' as never)).rejects.toThrow('Mentions must be a list of workspace ids')
    await expect(e.invoke('orchestrator.send', 'hi', undefined, [1] as never)).rejects.toThrow('Mentions must be a list')
    await expect(e.invoke('orchestrator.send', 'hi', undefined, Array(21).fill('w'))).rejects.toThrow('Mentions must be a list')
  })

  test('a removed workspace keeps its old message mention; a later message no longer resolves it', async () => {
    const { engine: e, hunter } = await start()
    await e.invoke('orchestrator.send', 'look at @hunter', undefined, [hunter.id])
    await idle(e)
    await e.invoke('workspace.remove', hunter.id)

    expect(await userEvents(e)).toMatchObject([{ mentions: [{ workspaceId: hunter.id, name: 'hunter' }] }])
    await e.invoke('orchestrator.send', 'and @hunter again', undefined, [hunter.id])
    await idle(e)
    // A removed workspace may end the session; the message then opens a new one.
    expect([...runtime.sent, ...runtime.orchestratorSpecs.map((s) => s.prompt)].join('\n')).toContain('"@hunter" (not a workspace)')
  })
})
