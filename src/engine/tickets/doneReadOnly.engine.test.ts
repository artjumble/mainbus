import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runGit } from '../git/git'
import { resolveHome, type HomePaths } from '../home'
import { createEngine, type Engine } from '../index'
import { makeRepo } from '../intake/testBoard'
import { FakeRuntime, scriptFromFile, type FakeStep } from '../runtime/fakeRuntime'
import type { ExecFn } from '../runtime/resolveClaude'

// Each test starts an engine over a real repository: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })
const INVESTIGATOR: FakeStep[] = [
  { emit: { kind: 'session', sessionId: 'inv' } },
  { callTool: 'submitReport', args: { markdown: '# Found it' } },
  { emit: { kind: 'turn_end', ok: true } }
]
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1])

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-doneRO-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  engines = []
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function setup() {
  const runtime = new FakeRuntime(scriptFromFile({ Investigator: INVESTIGATOR }), { orchestrator: [{ emit: { kind: 'session', sessionId: 'o' } }, { waitForSend: true }] })
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec })
  engines.push(engine)
  await engine.invoke('workspace.open', repoPath)
  const create = (title: string, extra: Record<string, unknown> = {}) =>
    engine.invoke('ticket.create', { title, intent: 'Words', spec: '', criteria: [], labels: [], column: 'ready', ...extra })
  const column = async (id: string) => (await engine.invoke('board.get')).tickets.find((t) => t.id === id)!.state.column
  return { engine, create, column }
}

const REFUSAL = (n: number) => `#${n} is Done, so it can't be changed. Move it back to Backlog or Ready to change it.`

describe('a Done ticket is read-only', () => {
  test('every command that changes its data is refused, and works again once it is moved back to Ready', async () => {
    const { engine, create, column } = await setup()
    const t = await create('Fix login')
    const other = await create('Other')
    const attached = await engine.invoke('attachment.add', t.id, 'a.png', png)
    expect(await engine.invoke('ticket.move', t.id, 'done')).toBe('moved')
    expect(await column(t.id)).toBe('done')

    const refused = [
      () => engine.invoke('ticket.update', t.id, { title: 'New' }),
      () => engine.invoke('ticket.update', t.id, { criteria: [{ position: 0, text: 'x', checked: true }] }),
      () => engine.invoke('ticket.appendIntent', t.id, 'More'),
      () => engine.invoke('ticket.setBlockedBy', t.id, [other.id]),
      () => engine.invoke('ticket.setRunSettings', t.id, null),
      () => engine.invoke('attachment.add', t.id, 'b.png', png),
      () => engine.invoke('attachment.remove', attached.id)
    ]
    for (const attempt of refused) await expect(attempt()).rejects.toThrow(REFUSAL(t.number))
    expect(await engine.invoke('attachment.list', t.id)).toHaveLength(1)

    expect(await engine.invoke('ticket.move', t.id, 'ready')).toBe('moved')
    expect((await engine.invoke('ticket.update', t.id, { title: 'New' })).title).toBe('New')
    expect((await engine.invoke('ticket.appendIntent', t.id, 'More')).intent).toHaveLength(2)
    await engine.invoke('ticket.setBlockedBy', t.id, [other.id])
    await engine.invoke('ticket.setRunSettings', t.id, null)
    await engine.invoke('attachment.add', t.id, 'b.png', png)
    await engine.invoke('attachment.remove', attached.id)
    expect(await engine.invoke('attachment.list', t.id)).toHaveLength(1)
  })

  test('another ticket can still drop a Done blocker', async () => {
    const { engine, create } = await setup()
    const blocker = await create('Blocker')
    const t = await create('Blocked')
    await engine.invoke('ticket.setBlockedBy', t.id, [blocker.id])
    expect(await engine.invoke('ticket.move', blocker.id, 'done')).toBe('moved')
    await engine.invoke('ticket.setBlockedBy', t.id, [])
    expect((await engine.invoke('board.get')).tickets.find((x) => x.id === t.id)!.blockedBy).toEqual([])
  })

  test('Promote on a Done Investigate ticket still works', async () => {
    const { engine, create, column } = await setup()
    const t = await create('Why slow', { kind: 'investigate' })
    await engine.invoke('agent.start', t.id)
    await vi.waitFor(async () => expect(await column(t.id)).toBe('review'))
    await vi.waitFor(async () => expect((await engine.invoke('board.get')).tickets.find((x) => x.id === t.id)!.reportCommit).not.toBeNull(), { timeout: 15_000 })
    expect(await engine.invoke('ticket.move', t.id, 'done')).toBe('moved')
    const created = await engine.invoke('ticket.promote', t.id, { title: 'Speed up', spec: 'Cache it.' })
    expect(created.promotedFrom).toBe(t.id)
  })
})
