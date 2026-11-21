import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runGit } from '../git/git'
import { FakeClock } from '../holds/clock'
import { type HomePaths } from '../home'
import { createEngine, type Engine } from '../index'
import { makeRepo } from '../intake/testBoard'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import type { ExecFn } from '../runtime/resolveClaude'
import { ALREADY_SENT_MESSAGE, QUEUE_HELD_TURN_FAILED } from './session'
import { WAKE_HEADING } from './wakeDigest'
import { WAKE_DEBOUNCE_MS } from './wakes'
import { eventually } from '../testWait'
import { testHome } from '../testFixtures'

// Each test starts an engine over a real repository: allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 })

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]
let clock: FakeClock

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-queue-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = await testHome(path.join(tmp, 'home'))
  engines = []
  clock = new FakeClock(new Date('2026-11-02T09:00:00.000Z'))
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const say = (text: string): FakeStep => ({ emit: { kind: 'message', text } })
const turnEnd = (ok = true): FakeStep => ({ emit: { kind: 'turn_end', ok, ...(ok ? {} : { error: 'boom' }) } })
const session = (id: string): FakeStep => ({ emit: { kind: 'session', sessionId: id } })
const next: FakeStep = { waitForSend: true }
/** Holds the first turn open until the test writes the `release` file in the orchestrator's folder. */
const hold: FakeStep = { waitForFile: 'release' }
/** A turn for each message after the first one. */
const REPLIES: FakeStep[] = [next, say('2'), turnEnd(), next, say('3'), turnEnd(), next, say('4'), turnEnd()]
/** The first turn stays open until released, then one turn per message sent. */
const HELD_FIRST: FakeStep[] = [session('sess-1'), hold, say('1'), turnEnd(), ...REPLIES]

async function makeEngine(runtime: FakeRuntime, extra: { clock?: FakeClock } = {}): Promise<Engine> {
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec, ...extra })
  engines.push(engine)
  await engine.invoke('workspace.open', repoPath)
  return engine
}

const release = (): Promise<void> => fs.writeFile(path.join(paths.root, 'orchestrator', 'release'), 'go')
const threadOf = (engine: Engine) => engine.invoke('orchestrator.get')
const queueTexts = async (engine: Engine) => (await threadOf(engine)).queue.items.map((i) => i.text)
const userTexts = async (engine: Engine) =>
  (await threadOf(engine)).events.flatMap((e) => (e.event.kind === 'user_message' ? [e.event.text] : []))
const idle = (engine: Engine) => eventually(async () => expect((await threadOf(engine)).status).toBe('idle'))
const sentEnding = (runtime: FakeRuntime) => runtime.sent.map((s) => s.split('\n').at(-1))

describe('queuing while the orchestrator works', () => {
  test('messages sent mid-turn are queued, never sent into the turn, and go out in order once it ends', async () => {
    const runtime = new FakeRuntime([], { orchestrator: HELD_FIRST })
    const engine = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'A')
    await engine.invoke('orchestrator.send', 'B')
    await engine.invoke('orchestrator.send', 'C')

    expect(runtime.sent).toEqual([])
    expect(await userTexts(engine)).toEqual(['A'])
    const thread = await threadOf(engine)
    expect(thread.status).toBe('working')
    expect(thread.queue.held).toBeNull()
    expect(thread.queue.items.map((i) => i.text)).toEqual(['B', 'C'])

    await release()
    await eventually(() => expect(runtime.sent).toHaveLength(2))
    await idle(engine)
    expect(sentEnding(runtime)).toEqual(['B', 'C'])
    expect(await userTexts(engine)).toEqual(['A', 'B', 'C'])
    expect(await queueTexts(engine)).toEqual([])
  })

  test('the queue changes are announced to the panel', async () => {
    const runtime = new FakeRuntime([], { orchestrator: HELD_FIRST })
    const engine = await makeEngine(runtime)
    const lengths: number[] = []
    engine.on((e) => {
      if (e.type === 'orchestrator.queue') lengths.push(e.queue.items.length)
    })
    await engine.invoke('orchestrator.send', 'A')
    await engine.invoke('orchestrator.send', 'B')
    await release()
    await eventually(() => expect(lengths).toEqual([1, 0]))
  })

  test('a queued message keeps its picked mentions and its images', async () => {
    const other = await makeRepo(path.join(tmp, 'website'))
    const runtime = new FakeRuntime([], { orchestrator: HELD_FIRST })
    const engine = await makeEngine(runtime)
    const website = await engine.invoke('workspace.open', other)
    await engine.invoke('workspace.focus', (await engine.invoke('workspace.list'))[0]!.id)
    await engine.invoke('orchestrator.send', 'A')
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    await engine.invoke('orchestrator.send', 'Look at @website now', [{ name: 'shot.png', bytes: png }], [website.id])
    const [queued] = (await threadOf(engine)).queue.items
    expect(queued).toMatchObject({ text: 'Look at @website now', mentions: [website.id], images: [{ filename: 'shot.png' }] })

    await release()
    await eventually(() => expect(runtime.sent).toHaveLength(1))
    expect(runtime.sent[0]).toContain(`website (id ${website.id}`)
    expect(runtime.sent[0]).toContain('shot.png')
    const message = (await threadOf(engine)).events.map((e) => e.event).find((e) => e.kind === 'user_message' && e.text === 'Look at @website now')
    expect(message).toMatchObject({ images: [{ filename: 'shot.png' }], mentions: [{ workspaceId: website.id }] })
  })
})

describe('the user comes before the wake rows', () => {
  test('a queued message is sent first; the wake digest rides in a later turn', async () => {
    const FAILING: FakeStep[] = [session('role-sess'), turnEnd(false), turnEnd(false)]
    const runtime = new FakeRuntime(FAILING, { orchestrator: [session('sess-1'), hold, say('1'), turnEnd(), next, say('2'), turnEnd(), next, say('3'), turnEnd()] })
    const engine = await makeEngine(runtime, { clock })
    await engine.invoke('orchestrator.send', 'A')
    const ticket = await engine.invoke('ticket.create', { title: 'Login', intent: 'Add a login form', spec: '', criteria: [], labels: [], column: 'ready' })
    await engine.invoke('agent.start', ticket.id)
    await eventually(async () => expect((await engine.invoke('board.get')).tickets[0]!.state.agentStatus).toBe('failed'))
    // The failure's news is due while the turn runs: it waits.
    await clock.advance(WAKE_DEBOUNCE_MS)
    await engine.invoke('orchestrator.send', 'B')
    expect(runtime.sent).toEqual([])

    await release()
    await eventually(() => expect(runtime.sent).toHaveLength(1))
    await idle(engine)
    expect(sentEnding(runtime)).toEqual(['B'])
    expect(runtime.sent[0]).not.toContain(WAKE_HEADING)

    await clock.advance(WAKE_DEBOUNCE_MS)
    await eventually(() => expect(runtime.sent).toHaveLength(2))
    expect(runtime.sent[1]).toContain(WAKE_HEADING)
    expect(await userTexts(engine)).toEqual(['A', 'B'])
  })
})

describe('Stop, a failed turn and Send now', () => {
  test('Stop keeps the queue, and the queued messages are sent next', async () => {
    const runtime = new FakeRuntime([], { orchestrator: [session('sess-1'), next, say('2'), turnEnd(), next, say('3'), turnEnd()], endTurnOnInterrupt: true })
    const engine = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'A')
    await engine.invoke('orchestrator.send', 'B')
    await engine.invoke('orchestrator.send', 'C')
    await engine.invoke('orchestrator.stop')

    await eventually(() => expect(runtime.sent).toHaveLength(2))
    expect(runtime.interrupted).toHaveLength(1)
    expect(sentEnding(runtime)).toEqual(['B', 'C'])
    await idle(engine)
    expect(await queueTexts(engine)).toEqual([])
  })

  test('a failed turn holds the queue with a note and sends nothing; Send now releases it, in order', async () => {
    const runtime = new FakeRuntime([], {
      orchestrator: [session('sess-1'), hold, turnEnd(false), next, say('2'), turnEnd(), next, say('3'), turnEnd()]
    })
    const engine = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'A')
    await engine.invoke('orchestrator.send', 'B')
    await engine.invoke('orchestrator.send', 'C')
    await release()
    await eventually(async () => expect((await threadOf(engine)).queue.held).toBe(QUEUE_HELD_TURN_FAILED))
    expect((await threadOf(engine)).status).toBe('failed')
    expect(runtime.sent).toEqual([])
    expect(await queueTexts(engine)).toEqual(['B', 'C'])

    // A new message joins the held queue; it isn't sent either.
    await engine.invoke('orchestrator.send', 'D')
    expect((await threadOf(engine)).queue.held).toBe(QUEUE_HELD_TURN_FAILED)
    expect(runtime.sent).toEqual([])

    const [, c] = (await threadOf(engine)).queue.items
    await engine.invoke('orchestrator.sendQueuedNow', c!.id)
    await eventually(() => expect(runtime.sent).toHaveLength(3))
    expect(sentEnding(runtime)).toEqual(['C', 'B', 'D'])
    expect((await threadOf(engine)).queue.held).toBeNull()
  })

  test('Send now interrupts the turn and sends that message first, the rest after it in order', async () => {
    const runtime = new FakeRuntime([], {
      orchestrator: [session('sess-1'), next, say('2'), turnEnd(), next, say('3'), turnEnd()],
      endTurnOnInterrupt: true
    })
    const engine = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'A')
    await engine.invoke('orchestrator.send', 'B')
    await engine.invoke('orchestrator.send', 'C')
    const [, c] = (await threadOf(engine)).queue.items
    expect(runtime.interrupted).toEqual([])
    await engine.invoke('orchestrator.sendQueuedNow', c!.id)

    await eventually(() => expect(runtime.sent).toHaveLength(2))
    expect(runtime.interrupted).toHaveLength(1)
    expect(sentEnding(runtime)).toEqual(['C', 'B'])
    expect(await userTexts(engine)).toEqual(['A', 'C', 'B'])
  })

  test('Send now says so when the message was already sent', async () => {
    const runtime = new FakeRuntime([], { orchestrator: HELD_FIRST })
    const engine = await makeEngine(runtime)
    await expect(engine.invoke('orchestrator.sendQueuedNow', 'nope')).rejects.toThrow(ALREADY_SENT_MESSAGE)
  })
})

describe('editing and removing queued messages', () => {
  test('Edit changes the words that are sent, Remove drops a message, and both refuse once it was sent', async () => {
    const runtime = new FakeRuntime([], { orchestrator: HELD_FIRST })
    const engine = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'A')
    await engine.invoke('orchestrator.send', 'B')
    await engine.invoke('orchestrator.send', 'C')
    await engine.invoke('orchestrator.send', 'D')
    const [b, c, d] = (await threadOf(engine)).queue.items
    await engine.invoke('orchestrator.editQueued', c!.id, 'C edited')
    await engine.invoke('orchestrator.removeQueued', d!.id)
    await expect(engine.invoke('orchestrator.editQueued', c!.id, '  ')).rejects.toThrow('Type a message first')
    await expect(engine.invoke('orchestrator.removeQueued', d!.id)).rejects.toThrow(ALREADY_SENT_MESSAGE)
    expect(await queueTexts(engine)).toEqual(['B', 'C edited'])

    await release()
    await eventually(() => expect(runtime.sent).toHaveLength(2))
    await idle(engine)
    expect(sentEnding(runtime)).toEqual(['B', 'C edited'])
    await expect(engine.invoke('orchestrator.editQueued', b!.id, 'late')).rejects.toThrow(ALREADY_SENT_MESSAGE)
    await expect(engine.invoke('orchestrator.removeQueued', b!.id)).rejects.toThrow(ALREADY_SENT_MESSAGE)
  })
})

describe('after a restart', () => {
  test('the queue survives, and is sent in order after recovery, resuming the session', async () => {
    const first = await makeEngine(new FakeRuntime([], { orchestrator: [session('sess-1'), { waitForFile: 'never' }] }))
    await first.invoke('orchestrator.send', 'A')
    await first.invoke('orchestrator.send', 'B')
    await first.invoke('orchestrator.send', 'C')
    await eventually(async () => expect((await threadOf(first)).events.map((e) => e.event.kind)).toContain('session'))
    await first.dispose()

    const runtime = new FakeRuntime([], { orchestrator: [say('2'), turnEnd(), next, say('3'), turnEnd()] })
    const engine = await makeEngine(runtime)
    await eventually(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    expect(runtime.orchestratorSpecs[0]!.resumeSessionId).toBe('sess-1')
    expect(runtime.orchestratorSpecs[0]!.prompt.split('\n').at(-1)).toBe('B')
    await eventually(() => expect(runtime.sent).toHaveLength(1))
    expect(sentEnding(runtime)).toEqual(['C'])
    await idle(engine)
    expect(await userTexts(engine)).toEqual(['A', 'B', 'C'])
    expect(await queueTexts(engine)).toEqual([])
  })

  test('a held queue stays held, and nothing is sent', async () => {
    const first = await makeEngine(new FakeRuntime([], { orchestrator: [session('sess-1'), hold, turnEnd(false)] }))
    await first.invoke('orchestrator.send', 'A')
    await first.invoke('orchestrator.send', 'B')
    await release()
    await eventually(async () => expect((await threadOf(first)).queue.held).toBe(QUEUE_HELD_TURN_FAILED))
    await first.dispose()

    const runtime = new FakeRuntime([], { orchestrator: [say('2'), turnEnd()] })
    const engine = await makeEngine(runtime)
    const thread = await threadOf(engine)
    expect(thread.queue).toMatchObject({ held: QUEUE_HELD_TURN_FAILED, items: [{ text: 'B' }] })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(runtime.orchestratorSpecs).toEqual([])

    await engine.invoke('orchestrator.sendQueuedNow', thread.queue.items[0]!.id)
    await eventually(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    await idle(engine)
    expect(await queueTexts(engine)).toEqual([])
  })
})

describe('what the orchestrator is told', () => {
  test('the outcome of a proposal opens the first queued message only', async () => {
    const runtime = new FakeRuntime([], {
      orchestrator: [session('sess-1'), { callTool: 'proposeCreateTickets', args: { tickets: [{ title: 'One' }] } }, hold, say('1'), turnEnd(), ...REPLIES]
    })
    const engine = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'A')
    await eventually(async () => expect((await threadOf(engine)).proposals).toHaveLength(1))
    await engine.invoke('proposal.reject', (await threadOf(engine)).proposals[0]!.id)
    await engine.invoke('orchestrator.send', 'B')
    await engine.invoke('orchestrator.send', 'C')
    await release()
    await eventually(() => expect(runtime.sent).toHaveLength(2))
    expect(runtime.sent[0]).toContain('rejected by the user')
    expect(runtime.sent[1]).not.toContain('rejected by the user')
  })

  test('each queued message is its own message of the user: request_messages_back reaches the one before', async () => {
    const runtime = new FakeRuntime([], {
      orchestrator: [
        session('sess-1'),
        hold,
        turnEnd(),
        next,
        turnEnd(),
        next,
        { callTool: 'createTickets', args: { workspace: 'repo', tickets: [{ title: 'From two messages' }], request_messages_back: 1 } },
        turnEnd()
      ]
    })
    const engine = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'A')
    await engine.invoke('orchestrator.send', 'Add a login form')
    await engine.invoke('orchestrator.send', 'Make it blue')
    await release()
    await eventually(async () => expect((await engine.invoke('board.get')).tickets).toHaveLength(1))
    const [ticket] = (await engine.invoke('board.get')).tickets
    expect(ticket!.intent.map((e) => e.text)).toEqual(['Add a login form', 'Make it blue'])
  })
})
