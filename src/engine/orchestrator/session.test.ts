import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { EngineEvent } from '../../shared/api'
import { runGit } from '../git/git'
import { resolveHome, type HomePaths } from '../home'
import { createEngine, type Engine } from '../index'
import { makeRepo } from '../intake/testBoard'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import type { ExecFn } from '../runtime/resolveClaude'
import type { AgentRuntime } from '../runtime/types'
import { RESUME_FAILED_NOTICE } from './session'

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

let tmp: string
let repoPath: string
let paths: HomePaths
let engines: Engine[]

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-orchestrator-'))
  repoPath = await makeRepo(path.join(tmp, 'repo'))
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  engines = []
})

afterEach(async () => {
  for (const e of engines) await e.dispose()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function makeEngine(runtime: AgentRuntime | null, open = true): Promise<{ engine: Engine; events: EngineEvent[] }> {
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec })
  engines.push(engine)
  if (open) await engine.invoke('workspace.open', repoPath)
  const events: EngineEvent[] = []
  engine.on((e) => events.push(e))
  return { engine, events }
}

const say = (text: string): FakeStep => ({ emit: { kind: 'message', text } })
const turnEnd = (ok = true): FakeStep => ({ emit: { kind: 'turn_end', ok } })

/** Two turns: a session id, a streamed reply, then a second reply after the next message. */
const TWO_TURNS: FakeStep[] = [
  { emit: { kind: 'session', sessionId: 'sess-1' } },
  { emit: { kind: 'message', text: 'Hel', partial: true } },
  say('Hello'),
  turnEnd(),
  { waitForSend: true },
  say('Second'),
  turnEnd()
]

async function status(engine: Engine) {
  return (await engine.invoke('orchestrator.get')).status
}

describe('orchestrator.send', () => {
  test('rejects empty text, a missing workspace and a missing runtime', async () => {
    const { engine } = await makeEngine(new FakeRuntime([]), false)
    await expect(engine.invoke('orchestrator.send', '')).rejects.toThrow('Type a message first')
    await expect(engine.invoke('orchestrator.send', '  \n ')).rejects.toThrow('Type a message first')
    await expect(engine.invoke('orchestrator.send', 'Hi')).rejects.toThrow('Open a workspace first')
    await engine.dispose()

    const { engine: noClaude } = await makeEngine(null)
    await expect(noClaude.invoke('orchestrator.send', 'Hi')).rejects.toThrow(/Claude Code is not set up/)
  })

  test('starts one orchestrator session in <home>\\orchestrator with the repo readable and a header on the message', async () => {
    const runtime = new FakeRuntime([], { orchestrator: TWO_TURNS })
    const { engine } = await makeEngine(runtime)
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 1, 14, 5) })
    try {
      await engine.invoke('orchestrator.send', 'What needs me?')
    } finally {
      vi.useRealTimers()
    }

    const folder = path.join(paths.root, 'orchestrator')
    const ticketFolders = path.join(paths.worktrees, 'repo')
    const attachments = path.join(paths.attachments, 'repo')
    expect((await fs.stat(ticketFolders)).isDirectory()).toBe(true)
    expect((await fs.stat(attachments)).isDirectory()).toBe(true)
    expect((await fs.stat(folder)).isDirectory()).toBe(true)
    expect(runtime.specs).toHaveLength(0)
    expect(runtime.orchestratorSpecs).toHaveLength(1)
    const spec = runtime.orchestratorSpecs[0]!
    expect(spec).toMatchObject({ kind: 'orchestrator', cwd: folder, additionalDirectories: [repoPath, ticketFolders, attachments], model: 'opus', effort: 'medium' })
    expect(spec.resumeSessionId).toBeUndefined()
    expect(spec.prompt).toBe(`[Mainbus] Focused workspace: repo (${repoPath}) · Local time: 2026-11-01 14:05, Sunday\n\nWhat needs me?`)
    expect(spec.appendSystemPrompt).toContain('Mainbus orchestrator')
    for (const tool of ['Bash', 'Edit', 'Write', 'AskUserQuestion', 'Agent', 'Task', 'EnterWorktree', 'CronCreate']) {
      expect(spec.disallowedTools).toContain(tool)
    }
    expect(spec.disallowedTools).not.toContain('WebFetch')
    expect(spec.disallowedTools).not.toContain('WebSearch')
    // Its permissions: reads in the repo, never a credential file, never anything else.
    const ask = (toolName: string, input: Record<string, unknown>) =>
      spec.onPermission({ toolName, input, toolUseId: 't', signal: new AbortController().signal })
    expect(await ask('Read', { file_path: path.join(repoPath, 'README.md') })).toEqual({ allow: true })
    expect((await ask('Read', { file_path: path.join(repoPath, '.env') })).allow).toBe(false)
    expect((await ask('Bash', { command: 'ls' })).allow).toBe(false)
    // Web pages: public ones are allowed until the user turns it off, which applies without a restart.
    expect(await ask('WebFetch', { url: 'https://example.com/docs' })).toEqual({ allow: true })
    expect((await ask('WebFetch', { url: 'http://localhost:8080' })).allow).toBe(false)
    await engine.invoke('settings.setOrchestratorWebAccess', false)
    expect((await ask('WebFetch', { url: 'https://example.com/docs' })).allow).toBe(false)
    expect((await ask('WebSearch', { query: 'x' })).allow).toBe(false)
    // So are reads in the ticket folders, including one made after the session started; never the scratch folders.
    const later = path.join(ticketFolders, '2-later')
    await fs.mkdir(later, { recursive: true })
    expect(await ask('Read', { file_path: path.join(later, 'a.ts') })).toEqual({ allow: true })
    expect((await ask('Write', { file_path: path.join(later, 'a.ts'), content: '' })).allow).toBe(false)
    expect((await ask('Read', { file_path: path.join(paths.scratch, 'repo', '2-later', 'a.txt') })).allow).toBe(false)
    expect(spec.appendSystemPrompt).toContain(`- ${ticketFolders}`)
    // Its read tools answer from this board.
    expect(await spec.tools.listWorkspaces()).toContain(`- repo (id `)
  })

  test('stores and pushes its events, streams partials unstored, and keeps one live session', async () => {
    const runtime = new FakeRuntime([], { orchestrator: TWO_TURNS })
    const { engine, events } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'First')
    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))

    const pushed = events.filter((e) => e.type === 'orchestrator.appended').map((e) => e.event)
    expect(pushed.map((e) => [e.seq, e.event.kind])).toEqual([
      [1, 'user_message'],
      [2, 'session'],
      [0, 'message'],
      [3, 'message'],
      [4, 'turn_end']
    ])
    const statuses = events.filter((e) => e.type === 'orchestrator.status').map((e) => e.status)
    expect(statuses).toEqual(['working', 'idle'])

    await engine.invoke('orchestrator.send', 'Next one')
    await vi.waitFor(async () => {
      const thread = await engine.invoke('orchestrator.get')
      expect(thread.events.at(-1)?.event.kind).toBe('turn_end')
      expect(thread.events.map((e) => e.event.kind)).toContain('user_message')
      expect(thread.events.length).toBe(7)
    })
    expect(runtime.orchestratorSpecs).toHaveLength(1)
    expect(runtime.sent).toHaveLength(1)
    expect(runtime.sent[0]).toMatch(/^\[Mainbus\] Focused workspace: repo .*\n\nNext one$/)

    const thread = await engine.invoke('orchestrator.get')
    expect(thread.status).toBe('idle')
    expect(thread.runs).toHaveLength(1)
    expect(thread.events.filter((e) => e.event.kind === 'user_message').map((e) => e.event)).toEqual([
      { kind: 'user_message', text: 'First' },
      { kind: 'user_message', text: 'Next one' }
    ])
    // The orchestrator is not a ticket: no board change, and unattended mode never hears of it.
    expect(events.some((e) => e.type === 'board.changed' || e.type === 'unattended.changed')).toBe(false)
    expect((await engine.invoke('unattended.get')).on).toBe(false)
  })

  test('a failing turn leaves it failed, and the next message works again', async () => {
    const runtime = new FakeRuntime([], {
      orchestrator: [turnEnd(false), { waitForSend: true }, say('Back'), turnEnd()]
    })
    const { engine } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'Hi')
    await vi.waitFor(async () => expect(await status(engine)).toBe('failed'))
    await engine.invoke('orchestrator.send', 'Again')
    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))
  })

  test('a process that ends mid-turn leaves it failed, and the next message resumes the session', async () => {
    const runtime = new FakeRuntime([], {
      orchestrator: (spec) =>
        spec.resumeSessionId ? [say('Resumed'), turnEnd()] : [{ emit: { kind: 'session', sessionId: 'sess-1' } }, { exit: 1 }]
    })
    const { engine } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'Hi')
    await vi.waitFor(async () => expect(await status(engine)).toBe('failed'))
    const kinds = (await engine.invoke('orchestrator.get')).events.map((e) => e.event.kind)
    expect(kinds).toEqual(['user_message', 'session', 'process_exit'])

    await engine.invoke('orchestrator.send', 'Still there?')
    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))
    expect(runtime.orchestratorSpecs.map((s) => s.resumeSessionId)).toEqual([undefined, 'sess-1'])
  })
})

describe('orchestrator usage', () => {
  const model = { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1 }
  const usage: FakeStep = { emit: { kind: 'usage', ...model, models: { m: model }, costUsd: 0.1, durationMs: 10 } }

  test("a turn's usage is recorded against the orchestrator, and a resumed session starts from its baseline", async () => {
    const runtime = new FakeRuntime([], {
      orchestrator: (spec) =>
        spec.resumeSessionId ? [say('Resumed'), turnEnd()] : [{ emit: { kind: 'session', sessionId: 'sess-1' } }, usage, { exit: 1 }]
    })
    const { engine } = await makeEngine(runtime)
    expect(await engine.invoke('orchestrator.usage')).toBeNull()
    await engine.invoke('orchestrator.send', 'Hi')
    await vi.waitFor(async () => expect(await status(engine)).toBe('failed'))
    expect(await engine.invoke('orchestrator.usage')).toMatchObject({ inputTokens: 5, outputTokens: 2, turns: 1, costUsd: 0.1 })

    await engine.invoke('orchestrator.send', 'Still there?')
    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))
    expect(runtime.orchestratorSpecs[0]!.usageBaseline).toBeUndefined()
    expect(runtime.orchestratorSpecs[1]!.usageBaseline).toEqual({ m: model })
  })
})

describe('orchestrator.stop', () => {
  test('interrupts the turn under way and keeps the session', async () => {
    const runtime = new FakeRuntime([], { orchestrator: [{ waitForSend: true }, say('Later'), turnEnd()], endTurnOnInterrupt: true })
    const { engine } = await makeEngine(runtime)
    // Nothing to stop yet.
    await engine.invoke('orchestrator.stop')
    expect(runtime.interrupted).toEqual([])

    await engine.invoke('orchestrator.send', 'Think hard')
    expect(await status(engine)).toBe('working')
    await engine.invoke('orchestrator.stop')
    expect(runtime.interrupted).toHaveLength(1)
    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))

    await engine.invoke('orchestrator.send', 'Never mind')
    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))
    expect(runtime.orchestratorSpecs).toHaveLength(1)
    expect(runtime.sent).toHaveLength(1)
  })
})

describe('after a restart', () => {
  async function firstSession(): Promise<void> {
    const { engine } = await makeEngine(new FakeRuntime([], { orchestrator: TWO_TURNS }))
    await engine.invoke('orchestrator.send', 'Plan the week')
    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))
    await engine.dispose()
  }

  test('the next message resumes the session by id', async () => {
    await firstSession()
    const runtime = new FakeRuntime([], { orchestrator: [say('Welcome back'), turnEnd()] })
    const { engine } = await makeEngine(runtime)
    const before = await engine.invoke('orchestrator.get')
    expect(before.status).toBe('idle')
    expect(before.events.map((e) => e.event.kind)).toEqual(['user_message', 'session', 'message', 'turn_end'])

    await engine.invoke('orchestrator.send', 'Where were we?')
    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))
    expect(runtime.orchestratorSpecs).toHaveLength(1)
    expect(runtime.orchestratorSpecs[0]!.resumeSessionId).toBe('sess-1')
    expect(runtime.orchestratorSpecs[0]!.prompt).toMatch(/\n\nWhere were we\?$/)
    const after = await engine.invoke('orchestrator.get')
    expect(after.runs).toHaveLength(1)
    expect(after.events.at(-2)?.event).toEqual({ kind: 'message', text: 'Welcome back' })
  })

  test('when the resume fails, a fresh session starts from a digest, with a notice', async () => {
    await firstSession()
    const runtime = new FakeRuntime([], { rejectResume: true, orchestrator: [say('Fresh start'), turnEnd()] })
    const { engine } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'Where were we?')
    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))

    expect(runtime.orchestratorSpecs.map((s) => s.resumeSessionId)).toEqual(['sess-1', undefined])
    const fresh = runtime.orchestratorSpecs[1]!.prompt
    expect(fresh).toContain("Mainbus couldn't resume your earlier conversation")
    expect(fresh).toContain('<ticket-data field="previous-conversation">\nUser: Plan the week\nOrchestrator: Hello\n</ticket-data>')
    // The new message is not part of the digest; it comes after it, with its header.
    expect(fresh.indexOf('Where were we?')).toBeGreaterThan(fresh.indexOf('</ticket-data>'))
    expect(fresh).toMatch(/\[Mainbus\] Focused workspace: repo .*\n\nWhere were we\?$/)

    const thread = await engine.invoke('orchestrator.get')
    expect(thread.runs.map((r) => r.endReason)).toEqual(['resume_failed', null])
    const second = thread.events.filter((e) => e.runId === thread.runs[1]!.id).map((e) => e.event)
    expect(second[0]).toEqual({ kind: 'notice', text: RESUME_FAILED_NOTICE })
    expect(second).toContainEqual({ kind: 'message', text: 'Fresh start' })
  })

  test('quitting mid-turn just ends the turn: nothing more is recorded and the run stays open', async () => {
    const { engine } = await makeEngine(
      new FakeRuntime([], { orchestrator: [{ emit: { kind: 'session', sessionId: 'sess-1' } }, say('Thinking about it')] })
    )
    await engine.invoke('orchestrator.send', 'Big question')
    await vi.waitFor(async () =>
      expect((await engine.invoke('orchestrator.get')).events.at(-1)?.event).toEqual({ kind: 'message', text: 'Thinking about it' })
    )
    await engine.dispose()

    const runtime = new FakeRuntime([])
    const { engine: next } = await makeEngine(runtime)
    const thread = await next.invoke('orchestrator.get')
    expect(thread.status).toBe('idle')
    expect(thread.runs).toEqual([expect.objectContaining({ endReason: null })])
    expect(thread.events.map((e) => e.event.kind)).toEqual(['user_message', 'session', 'message'])
  })
})

describe('proposals', () => {
  const ASK = '  Please add two tickets:\nlogin and logout  '
  const DRAFTS = { tickets: [{ title: 'Login', spec: 'A form on /login' }, { title: 'Logout' }] }
  const intentsOf = async (engine: Engine) => {
    const board = await engine.invoke('board.get')
    return board.tickets.map((t) => [t.title, t.intent.map((e) => e.text), t.intent[0]!.source])
  }

  /** The live session's tools, once the first message has started it. */
  async function liveTools(runtime: FakeRuntime) {
    await vi.waitFor(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    return runtime.orchestratorSpecs[0]!.tools
  }

  test('propose stores the proposal, puts its card in the thread, and tells the orchestrator to end its turn', async () => {
    // The turn stays open (no turn_end) while the test proposes, as the agent would mid-turn.
    const runtime = new FakeRuntime([], { orchestrator: [{ emit: { kind: 'session', sessionId: 'sess-1' } }, { waitForSend: true }] })
    const { engine, events } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', ASK)
    const tools = await liveTools(runtime)

    const answer = await tools.proposeCreateTickets({ ...DRAFTS, evidence: 'No auth in src/' })
    const thread = await engine.invoke('orchestrator.get')
    expect(thread.proposals).toHaveLength(1)
    const proposal = thread.proposals[0]!
    expect(answer).toBe(
      `Proposed ${proposal.id}. The user will confirm, change or reject it, and you'll hear the outcome in your next turn. End your turn now.`
    )
    // The intent is the user's message as typed: not trimmed, and without the header.
    expect(proposal).toMatchObject({
      status: 'pending',
      evidence: 'No auth in src/',
      orchestratorRunId: thread.runs[0]!.id,
      payload: { intent: ASK, column: 'backlog', tickets: [{ title: 'Login', spec: 'A form on /login' }, { title: 'Logout' }] }
    })
    expect(thread.events.at(-1)?.event).toEqual({ kind: 'proposal', proposalId: proposal.id })
    // The renderer has the proposal before its card's event arrives.
    const order = events.flatMap((e) =>
      e.type === 'proposal.changed' ? ['changed'] : e.type === 'orchestrator.appended' && e.event.event.kind === 'proposal' ? ['card'] : []
    )
    expect(order).toEqual(['changed', 'card'])
    // Nothing is created until the user confirms.
    expect((await engine.invoke('board.get')).tickets).toEqual([])
  })

  test('a proposal keeps the context in its payload, and other kinds refuse it', async () => {
    const runtime = new FakeRuntime([], { orchestrator: [{ waitForSend: true }] })
    const { engine } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', ASK)
    const tools = await liveTools(runtime)
    await tools.proposeCreateTickets({ ...DRAFTS, context: 'The user asked for login.' })
    expect((await engine.invoke('orchestrator.get')).proposals[0]!.payload).toMatchObject({ context: 'The user asked for login.' })
    expect(await tools.proposeHold({ ticket: 1, reason: 'x', context: 'y' })).toMatch(/Unknown field: context/)
  })

  test('an invalid proposal stores nothing, and the orchestrator hears why', async () => {
    const runtime = new FakeRuntime([], { orchestrator: [{ waitForSend: true }] })
    const { engine } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', ASK)
    const tools = await liveTools(runtime)
    expect(await tools.proposeCreateTickets({ tickets: [{ title: 'Login', intent: 'The user wants SSO' }] })).toBe(
      'Invalid proposal: Unknown field: tickets.0.intent. Nothing was stored; fix it and propose again.'
    )
    const thread = await engine.invoke('orchestrator.get')
    expect(thread.proposals).toEqual([])
    expect(thread.events.map((e) => e.event.kind)).not.toContain('proposal')
  })

  test('confirm creates the tickets with the user message as their intent; the next message starts with the outcome, once', async () => {
    const runtime = new FakeRuntime([], {
      orchestrator: [
        { emit: { kind: 'session', sessionId: 'sess-1' } },
        { callTool: 'proposeCreateTickets', args: DRAFTS },
        turnEnd(),
        { waitForSend: true },
        turnEnd(),
        { waitForSend: true },
        turnEnd()
      ]
    })
    const { engine } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', ASK)
    await vi.waitFor(async () => expect((await engine.invoke('orchestrator.get')).proposals).toHaveLength(1))
    const [proposal] = (await engine.invoke('orchestrator.get')).proposals
    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))

    const done = await engine.invoke('proposal.confirm', proposal!.id)
    expect(done.status).toBe('confirmed')
    expect(await intentsOf(engine)).toEqual([
      ['Login', [ASK], undefined],
      ['Logout', [ASK], undefined]
    ])
    expect((await engine.invoke('board.get')).tickets.map((t) => t.spec)).toEqual(['A form on /login', ''])
    await expect(engine.invoke('proposal.confirm', proposal!.id)).rejects.toThrow('not pending')

    await engine.invoke('orchestrator.send', 'Thanks')
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
    expect(runtime.sent[0]!.startsWith(
      [
        '[Mainbus] Since your last turn, the user decided on your proposals:',
        `- Proposal ${proposal!.id} (create tickets): confirmed by the user. Created #1 "Login" and #2 "Logout" in Backlog.`,
        '',
        '[Mainbus] Focused workspace: repo '
      ].join('\n')
    )).toBe(true)
    expect(runtime.sent[0]).toMatch(/\n\nThanks$/)
    // The panel shows only what the user typed.
    const messages = (await engine.invoke('orchestrator.get')).events.filter((e) => e.event.kind === 'user_message')
    expect(messages.at(-1)?.event).toEqual({ kind: 'user_message', text: 'Thanks' })

    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))
    await engine.invoke('orchestrator.send', 'And now?')
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(2))
    expect(runtime.sent[1]).toMatch(/^\[Mainbus\] Focused workspace: repo .*\n\nAnd now\?$/)
  })

  test('a rejected proposal is told as rejected and creates nothing', async () => {
    const runtime = new FakeRuntime([], {
      orchestrator: [{ callTool: 'proposeCreateTickets', args: DRAFTS }, turnEnd(), { waitForSend: true }, turnEnd()]
    })
    const { engine } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', ASK)
    await vi.waitFor(async () => expect((await engine.invoke('orchestrator.get')).proposals).toHaveLength(1))
    const [proposal] = (await engine.invoke('orchestrator.get')).proposals
    expect((await engine.invoke('proposal.reject', proposal!.id)).status).toBe('rejected')
    await expect(engine.invoke('proposal.reject', proposal!.id)).rejects.toThrow('not pending')
    expect((await engine.invoke('board.get')).tickets).toEqual([])

    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))
    await engine.invoke('orchestrator.send', 'Ok')
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
    expect(runtime.sent[0]).toContain(`- Proposal ${proposal!.id} (create tickets): rejected by the user.`)
  })

  test('a message sent while a turn is running is refused, and nothing is recorded or sent', async () => {
    const runtime = new FakeRuntime([], { orchestrator: [{ emit: { kind: 'session', sessionId: 'sess-1' } }, { waitForSend: true }] })
    const { engine } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'First ask')
    expect(await status(engine)).toBe('working')
    const before = (await engine.invoke('orchestrator.get')).events.length

    await expect(engine.invoke('orchestrator.send', 'Second ask')).rejects.toThrow(
      'The orchestrator is still working: wait for it, or Stop it first'
    )
    expect(runtime.sent).toEqual([])
    const thread = await engine.invoke('orchestrator.get')
    expect(thread.events.filter((e) => e.event.kind === 'user_message').map((e) => (e.event as { text: string }).text)).toEqual(['First ask'])
    expect(thread.events.length).toBeGreaterThanOrEqual(before)
    expect(thread.status).toBe('working')

    await (await liveTools(runtime)).proposeCreateTickets({ tickets: [{ title: 'From the first' }] })
    expect((await engine.invoke('orchestrator.get')).proposals.map((p) => (p.payload as { intent: string }).intent)).toEqual(['First ask'])
  })

  test('two turns in a row each propose with their own message', async () => {
    const runtime = new FakeRuntime([], {
      orchestrator: [
        { emit: { kind: 'session', sessionId: 'sess-1' } },
        { callTool: 'proposeCreateTickets', args: { tickets: [{ title: 'One' }] } },
        turnEnd(),
        { waitForSend: true },
        { callTool: 'proposeCreateTickets', args: { tickets: [{ title: 'Two' }] } },
        turnEnd()
      ]
    })
    const { engine } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'First ask')
    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))
    await engine.invoke('orchestrator.send', 'Second ask')
    await vi.waitFor(async () => expect((await engine.invoke('orchestrator.get')).proposals).toHaveLength(2))
    expect((await engine.invoke('orchestrator.get')).proposals.map((p) => (p.payload as { intent: string }).intent)).toEqual([
      'First ask',
      'Second ask'
    ])
  })

  test('after Stop, the next message is the intent of the next proposal', async () => {
    const runtime = new FakeRuntime([], {
      orchestrator: [{ emit: { kind: 'session', sessionId: 'sess-1' } }, { waitForSend: true }],
      endTurnOnInterrupt: true
    })
    const { engine } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'First ask')
    await engine.invoke('orchestrator.stop')
    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))
    await engine.invoke('orchestrator.send', 'Second ask')
    await (await liveTools(runtime)).proposeCreateTickets({ tickets: [{ title: 'After stop' }] })
    expect((await engine.invoke('orchestrator.get')).proposals.map((p) => (p.payload as { intent: string }).intent)).toEqual(['Second ask'])
  })

  test('a start proposal, confirmed, starts a Backlog ticket with its roles, models and instructions', async () => {
    // Each role agent stays alive, so the run stays open.
    const runtime = new FakeRuntime([{ waitForSend: true }], {
      orchestrator: [{ emit: { kind: 'session', sessionId: 'sess-1' } }, { waitForSend: true }]
    })
    const { engine } = await makeEngine(runtime)
    const t = await engine.invoke('ticket.create', {
      title: 'Login',
      intent: 'Add a login form',
      spec: '',
      criteria: [],
      labels: [],
      column: 'backlog'
    })
    const done = await engine.invoke('ticket.create', { title: 'Old', intent: 'x', spec: '', criteria: [], labels: [], column: 'ready' })
    expect(await engine.invoke('ticket.move', done.id, 'done')).toBe('moved')
    await engine.invoke('orchestrator.send', 'Start the login ticket')
    const tools = await liveTools(runtime)

    expect(await tools.proposeStart({ ticket: done.number })).toBe(
      `Invalid proposal: ticket: #${done.number} is in Done; only Backlog or Ready tickets can be started. Nothing was stored; fix it and propose again.`
    )
    expect(await tools.proposeStart({ ticket: t.number, roles: [{ role: 'Tester' }] })).toMatch(/^Invalid proposal: roles: there is no role "Tester"/)

    await tools.proposeStart({
      ticket: t.number,
      roles: [{ role: 'Planner', model: 'haiku' }, { role: 'Implementer' }],
      extraInstructions: 'Keep it small.',
      reason: 'It is ready to go'
    })
    const [proposal] = (await engine.invoke('orchestrator.get')).proposals
    expect(proposal).toMatchObject({ kind: 'start_lineup', evidence: 'It is ready to go' })

    const confirmed = await engine.invoke('proposal.confirm', proposal!.id, {
      roles: (proposal!.payload as { roles: { roleId: string; name: string }[] }).roles
        .filter((r) => r.name === 'Implementer')
        .map((r) => ({ roleId: r.roleId, model: 'opus', effort: 'low' })),
      extraInstructions: 'Keep it very small.'
    })
    expect(confirmed).toMatchObject({ status: 'overridden', result: { roles: [{ name: 'Implementer', model: 'opus', effort: 'low' }] } })
    await vi.waitFor(() => expect(runtime.specs).toHaveLength(1))
    expect(runtime.specs[0]).toMatchObject({ role: 'Implementer', model: 'opus', effort: 'low' })
    expect(runtime.specs[0]!.appendSystemPrompt).toContain('Keep it very small.')
    const ticket = (await engine.invoke('board.get')).tickets.find((x) => x.id === t.id)!
    expect(ticket.state.column).toBe('in_progress')
    expect(ticket.lineup.map((r) => r.name)).toEqual(['Implementer'])

    // Now it is running: another start is refused.
    expect(await tools.proposeStart({ ticket: t.number })).toBe(
      `Invalid proposal: ticket: #${t.number} is already running. Nothing was stored; fix it and propose again.`
    )
  })

  test('a pending proposal survives a restart, can be confirmed after it, and the next message hears of it', async () => {
    const first = new FakeRuntime([], {
      orchestrator: [{ emit: { kind: 'session', sessionId: 'sess-1' } }, { callTool: 'proposeCreateTickets', args: DRAFTS }, turnEnd()]
    })
    const { engine } = await makeEngine(first)
    await engine.invoke('orchestrator.send', ASK)
    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))
    const [proposal] = (await engine.invoke('orchestrator.get')).proposals
    await engine.dispose()

    const runtime = new FakeRuntime([], { orchestrator: [turnEnd()] })
    const { engine: next } = await makeEngine(runtime)
    const thread = await next.invoke('orchestrator.get')
    expect(thread.proposals).toEqual([expect.objectContaining({ id: proposal!.id, status: 'pending' })])
    expect(thread.events.map((e) => e.event)).toContainEqual({ kind: 'proposal', proposalId: proposal!.id })

    await next.invoke('proposal.confirm', proposal!.id, {
      tickets: [{ title: 'Sign in', spec: 'Edited', criteria: ['works'], labels: [] }],
      column: 'ready'
    })
    expect(await intentsOf(next)).toEqual([['Sign in', [ASK], undefined]])
    expect((await next.invoke('board.get')).tickets[0]!.state.column).toBe('ready')

    await next.invoke('orchestrator.send', 'Done?')
    await vi.waitFor(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    expect(runtime.orchestratorSpecs[0]!.resumeSessionId).toBe('sess-1')
    expect(runtime.orchestratorSpecs[0]!.prompt).toMatch(
      new RegExp(`^\\[Mainbus\\] Since your last turn.*\\n- Proposal ${proposal!.id} \\(create tickets\\): changed by the user, then confirmed\\. Created #1 "Sign in" in Ready\\.\\n\\n\\[Mainbus\\] Focused workspace`)
    )
  })
})

describe('create_tickets', () => {
  /** The live session's tools, once the first message has started it. */
  async function liveTools(runtime: FakeRuntime) {
    await vi.waitFor(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
    return runtime.orchestratorSpecs[0]!.tools
  }

  /** A second workspace, "website", opened before the first message so the session can read it from the start. */
  async function openWebsite(engine: Engine) {
    const website = await engine.invoke('workspace.open', await makeRepo(path.join(tmp, 'website')))
    const repo = (await engine.invoke('workspace.list')).find((w) => w.name === 'repo')!
    // The focused workspace is not the answer: it stays on repo.
    await engine.invoke('workspace.focus', repo.id)
    return { website, repo }
  }

  const boardOf = async (engine: Engine, workspaceId: string) => (await engine.invoke('board.get', workspaceId)).tickets

  const userMessages = async (engine: Engine) =>
    (await engine.invoke('orchestrator.get')).events.filter((e) => e.event.kind === 'user_message')

  test("creates the tickets in the named workspace's Backlog at once, with a receipt in the thread and no proposal", async () => {
    const runtime = new FakeRuntime([], { orchestrator: [{ emit: { kind: 'session', sessionId: 'sess-1' } }, { waitForSend: true }] })
    const { engine, events } = await makeEngine(runtime)
    const { website, repo } = await openWebsite(engine)
    await engine.invoke('orchestrator.send', 'Add login and logout to the website')
    const tools = await liveTools(runtime)

    const answer = await tools.createTickets({ workspace: 'website', tickets: [{ title: 'Login', spec: 'A form' }, { title: 'Logout', kind: 'investigate' }] })
    expect(answer).toBe(`Created #1 "Login" and #2 "Logout" in website's Backlog. Tell the user which workspace they went into.`)

    const created = await boardOf(engine, website.id)
    expect(created.map((t) => [t.number, t.title, t.kind, t.spec, t.manualColumn])).toEqual([
      [1, 'Login', 'change', 'A form', 'backlog'],
      [2, 'Logout', 'investigate', '', 'backlog']
    ])
    // The intent is the user's message, marked as created by the orchestrator at their request; no agent source.
    for (const t of created) {
      expect(t.intent).toHaveLength(1)
      expect(t.intent[0]).toMatchObject({ text: 'Add login and logout to the website', via: 'orchestrator' })
      expect(t.intent[0]!.source).toBeUndefined()
    }
    expect(await boardOf(engine, repo.id)).toEqual([])

    const thread = await engine.invoke('orchestrator.get')
    expect(thread.proposals).toEqual([])
    expect(thread.events.at(-1)?.event).toEqual({
      kind: 'tickets_created',
      workspaceId: website.id,
      workspace: 'website',
      tickets: created.map((t) => ({ id: t.id, number: t.number, title: t.title }))
    })
    // The board updates live.
    expect(events).toContainEqual({ type: 'board.changed', workspaceId: website.id })
  })

  test("a context becomes the orchestrator's entry after both of the user's messages, and the receipt says so", async () => {
    const runtime = new FakeRuntime([], {
      orchestrator: [{ emit: { kind: 'session', sessionId: 'sess-1' } }, turnEnd(), { waitForSend: true }]
    })
    const { engine } = await makeEngine(runtime)
    const { website } = await openWebsite(engine)
    await engine.invoke('orchestrator.send', 'Can images be attached?')
    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))
    await engine.invoke('orchestrator.send', 'Yes, create a ticket')
    const tools = await liveTools(runtime)
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))

    await tools.createTickets({ workspace: 'website', tickets: [{ title: 'Images' }], request_messages_back: 1, context: 'The user asked about images.' })
    const [t] = await boardOf(engine, website.id)
    expect(t!.intent.map((e) => e.text)).toEqual(['Can images be attached?', 'Yes, create a ticket', 'The user asked about images.'])
    expect(t!.intent[0]!.source).toBeUndefined()
    expect(t!.intent[1]!.source).toBeUndefined()
    expect(t!.intent[2]!.source).toMatchObject({ kind: 'agent', agent: 'orchestrator' })
    expect(path.basename(t!.intent[2]!.source!.cwd)).toBe('orchestrator')
    expect((await engine.invoke('orchestrator.get')).events.at(-1)?.event).toMatchObject({ kind: 'tickets_created', context: true })

    await tools.createTickets({ workspace: 'website', tickets: [{ title: 'Plain' }] })
    expect((await engine.invoke('orchestrator.get')).events.at(-1)?.event).not.toHaveProperty('context')
  })

  test('with more than one workspace open, a missing workspace creates nothing and the error lists them', async () => {
    const runtime = new FakeRuntime([], { orchestrator: [{ waitForSend: true }] })
    const { engine } = await makeEngine(runtime)
    const { website, repo } = await openWebsite(engine)
    await engine.invoke('orchestrator.send', 'Add a login ticket')
    const tools = await liveTools(runtime)

    const answer = await tools.createTickets({ tickets: [{ title: 'Login' }] })
    expect(answer).toBe(
      `More than one workspace is open: repo (id ${repo.id}), website (id ${website.id}). Name one with workspace: infer it from the user's words or ` +
        `the recent conversation; if they don't make it clear, ask the user which one and end your turn. Nothing was created.`
    )
    expect(await tools.createTickets({ workspace: '  ', tickets: [{ title: 'Login' }] })).toMatch(/^More than one workspace is open/)
    expect(await boardOf(engine, repo.id)).toEqual([])
    expect(await boardOf(engine, website.id)).toEqual([])
    expect((await engine.invoke('orchestrator.get')).events.map((e) => e.event.kind)).not.toContain('tickets_created')
  })

  test('with one workspace open, the workspace may be left out', async () => {
    const runtime = new FakeRuntime([], { orchestrator: [{ waitForSend: true }] })
    const { engine } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'Add a login ticket')
    const tools = await liveTools(runtime)
    expect(await tools.createTickets({ tickets: [{ title: 'Login' }] })).toBe(
      `Created #1 "Login" in repo's Backlog. Tell the user which workspace they went into.`
    )
    expect((await engine.invoke('board.get')).tickets.map((t) => [t.title, t.manualColumn])).toEqual([['Login', 'backlog']])
  })

  test('an unknown workspace is refused with the open ones', async () => {
    const runtime = new FakeRuntime([], { orchestrator: [{ waitForSend: true }] })
    const { engine } = await makeEngine(runtime)
    const { website, repo } = await openWebsite(engine)
    await engine.invoke('orchestrator.send', 'Add a login ticket')
    const tools = await liveTools(runtime)
    expect(await tools.createTickets({ workspace: 'shop', tickets: [{ title: 'Login' }] })).toBe(
      `No workspace "shop". The workspaces are: repo (id ${repo.id}), website (id ${website.id}). Nothing was created.`
    )
    expect(await boardOf(engine, repo.id)).toEqual([])
    expect(await boardOf(engine, website.id)).toEqual([])
  })

  test('creates all or none: an invalid draft, more than 20 drafts, a column or an intent creates nothing', async () => {
    const runtime = new FakeRuntime([], { orchestrator: [{ waitForSend: true }] })
    const { engine } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'Add tickets')
    const tools = await liveTools(runtime)

    expect(await tools.createTickets({ tickets: [{ title: 'Good' }, { title: '' }] })).toMatch(/^Invalid: tickets\.1\.title: .*Nothing was created; fix it and try again\.$/)
    const many = Array.from({ length: 21 }, (_, i) => ({ title: `T${i}` }))
    expect(await tools.createTickets({ tickets: many })).toBe('Invalid: tickets: must have at most 20 tickets. Nothing was created; fix it and try again.')
    expect(await tools.createTickets({ tickets: [{ title: 'Login' }], column: 'ready' })).toBe(
      'Invalid: Unknown field: column. Nothing was created; fix it and try again.'
    )
    expect(await tools.createTickets({ tickets: [{ title: 'Login', intent: 'Mine' }] })).toBe(
      'Invalid: Unknown field: tickets.0.intent. Nothing was created; fix it and try again.'
    )
    expect(await tools.createTickets({ tickets: [] })).toMatch(/^Invalid: tickets: must have at least 1 ticket/)
    expect((await engine.invoke('board.get')).tickets).toEqual([])

    // Exactly 20 is fine.
    expect(await tools.createTickets({ tickets: many.slice(0, 20) })).toMatch(/^Created #1 "T0", .* and #20 "T19" in repo's Backlog\./)
  })

  test('the intent is the request named by request_messages_back and every later message, verbatim and in order', async () => {
    const runtime = new FakeRuntime([], {
      orchestrator: [{ emit: { kind: 'session', sessionId: 'sess-1' } }, turnEnd(), { waitForSend: true }, turnEnd(), { waitForSend: true }]
    })
    const { engine } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', '  Add a login page\nwith SSO  ')
    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))
    await engine.invoke('orchestrator.send', 'And a logout button')
    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))
    await engine.invoke('orchestrator.send', 'repo')
    const tools = await liveTools(runtime)
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(2))
    const [, second, third] = await userMessages(engine)

    await tools.createTickets({ tickets: [{ title: 'Zero' }] })
    await tools.createTickets({ tickets: [{ title: 'One' }], request_messages_back: 1 })
    await tools.createTickets({ tickets: [{ title: 'Two' }], request_messages_back: 2 })
    const byTitle = new Map((await engine.invoke('board.get')).tickets.map((t) => [t.title, t.intent]))
    expect(byTitle.get('Zero')!.map((e) => e.text)).toEqual(['repo'])
    expect(byTitle.get('One')!.map((e) => e.text)).toEqual(['And a logout button', 'repo'])
    expect(byTitle.get('Two')!.map((e) => e.text)).toEqual(['  Add a login page\nwith SSO  ', 'And a logout button', 'repo'])
    // The later messages are marked with when the user sent them, as additions are; only the first is marked as the orchestrator's doing.
    expect(byTitle.get('Two')!.slice(1)).toEqual([
      { text: 'And a logout button', at: second!.at },
      { text: 'repo', at: third!.at }
    ])
    expect(byTitle.get('Two')![0]!.via).toBe('orchestrator')
  })

  test('request_messages_back out of range or past the first message is refused, creating nothing', async () => {
    const runtime = new FakeRuntime([], { orchestrator: [{ waitForSend: true }] })
    const { engine } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'Add a login ticket')
    const tools = await liveTools(runtime)
    const draft = { tickets: [{ title: 'Login' }] }
    for (const back of [6, -1, 1.5, '1']) {
      expect(await tools.createTickets({ ...draft, request_messages_back: back })).toBe(
        'Invalid: request_messages_back: must be a whole number from 0 to 5. Nothing was created; fix it and try again.'
      )
    }
    expect(await tools.createTickets({ ...draft, request_messages_back: 1 })).toBe(
      'Invalid: request_messages_back: there is no earlier message of the user. Nothing was created; fix it and try again.'
    )
    expect(await tools.proposeCreateTickets({ ...draft, request_messages_back: 9 })).toBe(
      'Invalid proposal: request_messages_back: must be a whole number from 0 to 5. Nothing was stored; fix it and propose again.'
    )
    expect((await engine.invoke('board.get')).tickets).toEqual([])
    expect((await engine.invoke('orchestrator.get')).proposals).toEqual([])
  })

  test('propose_create_tickets takes request_messages_back too: the confirmed tickets carry every message of the request', async () => {
    const runtime = new FakeRuntime([], {
      orchestrator: [{ emit: { kind: 'session', sessionId: 'sess-1' } }, turnEnd(), { waitForSend: true }, turnEnd(), { waitForSend: true }]
    })
    const { engine } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'Draft a login ticket')
    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))
    await engine.invoke('orchestrator.send', 'With SSO')
    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))
    await engine.invoke('orchestrator.send', 'Put it in Ready')
    const tools = await liveTools(runtime)
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(2))
    const [, second, third] = await userMessages(engine)

    expect(await tools.proposeCreateTickets({ tickets: [{ title: 'Login' }], column: 'ready', request_messages_back: 2 })).toMatch(/^Proposed /)
    const [proposal] = (await engine.invoke('orchestrator.get')).proposals
    expect(proposal!.payload).toMatchObject({
      intent: 'Draft a login ticket',
      intentAdded: [
        { text: 'With SSO', at: second!.at },
        { text: 'Put it in Ready', at: third!.at }
      ]
    })
    // An override keeps the request as it was.
    await engine.invoke('proposal.confirm', proposal!.id, { tickets: [{ title: 'Sign in', spec: '', criteria: [], labels: [] }], column: 'ready' })
    const [ticket] = (await engine.invoke('board.get')).tickets
    expect(ticket!.title).toBe('Sign in')
    expect(ticket!.intent.map((e) => e.text)).toEqual(['Draft a login ticket', 'With SSO', 'Put it in Ready'])
    // A confirmed proposal is the user's own creation, not the orchestrator's.
    expect(ticket!.intent[0]!.via).toBeUndefined()

    // 0 (or left out) is this turn's message alone, as before.
    await tools.proposeCreateTickets({ tickets: [{ title: 'Only now' }], request_messages_back: 0 })
    const latest = (await engine.invoke('orchestrator.get')).proposals.at(-1)!
    expect(latest.payload).toMatchObject({ intent: 'Put it in Ready' })
    expect((latest.payload as { intentAdded?: unknown }).intentAdded).toBeUndefined()
  })

  test('other propose tools refuse request_messages_back', async () => {
    const runtime = new FakeRuntime([], { orchestrator: [{ waitForSend: true }] })
    const { engine } = await makeEngine(runtime)
    const ticket = await engine.invoke('ticket.create', { title: 'T', intent: 'i', spec: '', criteria: [], labels: [], column: 'backlog' })
    await engine.invoke('orchestrator.send', 'Hold it')
    const tools = await liveTools(runtime)
    expect(await tools.proposeHold({ ticket: ticket.number, reason: 'Wait', request_messages_back: 1 })).toBe(
      'Invalid proposal: Unknown field: request_messages_back. Nothing was stored; fix it and propose again.'
    )
  })
})
