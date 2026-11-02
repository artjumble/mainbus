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
    expect((await fs.stat(folder)).isDirectory()).toBe(true)
    expect(runtime.specs).toHaveLength(0)
    expect(runtime.orchestratorSpecs).toHaveLength(1)
    const spec = runtime.orchestratorSpecs[0]!
    expect(spec).toMatchObject({ kind: 'orchestrator', cwd: folder, additionalDirectories: [repoPath], model: 'opus', effort: 'medium' })
    expect(spec.resumeSessionId).toBeUndefined()
    expect(spec.prompt).toBe(`[Mainbus] Workspace: repo (${repoPath}) · Local time: 2026-11-01 14:05, Sunday\n\nWhat needs me?`)
    expect(spec.appendSystemPrompt).toContain('Mainbus orchestrator')
    for (const tool of ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'Agent', 'Task', 'EnterWorktree', 'CronCreate']) {
      expect(spec.disallowedTools).toContain(tool)
    }
    // Its permissions: reads in the repo, never a credential file, never anything else.
    const ask = (toolName: string, input: Record<string, unknown>) =>
      spec.onPermission({ toolName, input, toolUseId: 't', signal: new AbortController().signal })
    expect(await ask('Read', { file_path: path.join(repoPath, 'README.md') })).toEqual({ allow: true })
    expect((await ask('Read', { file_path: path.join(repoPath, '.env') })).allow).toBe(false)
    expect((await ask('Bash', { command: 'ls' })).allow).toBe(false)
    // Its read tools answer from this board.
    expect(await spec.tools.listWorkspaces()).toContain(`- repo: repo ${repoPath}, base branch main`)
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
    expect(runtime.sent[0]).toMatch(/^\[Mainbus\] Workspace: repo .*\n\nNext one$/)

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

describe('orchestrator.stop', () => {
  test('interrupts the turn under way and keeps the session', async () => {
    const runtime = new FakeRuntime([], { orchestrator: [{ waitForSend: true }, say('Later'), turnEnd()] })
    const { engine } = await makeEngine(runtime)
    // Nothing to stop yet.
    await engine.invoke('orchestrator.stop')
    expect(runtime.interrupted).toEqual([])

    await engine.invoke('orchestrator.send', 'Think hard')
    expect(await status(engine)).toBe('working')
    await engine.invoke('orchestrator.stop')
    expect(runtime.interrupted).toHaveLength(1)

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
    expect(fresh).toMatch(/\[Mainbus\] Workspace: repo .*\n\nWhere were we\?$/)

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
        '[Mainbus] Workspace: repo '
      ].join('\n')
    )).toBe(true)
    expect(runtime.sent[0]).toMatch(/\n\nThanks$/)
    // The panel shows only what the user typed.
    const messages = (await engine.invoke('orchestrator.get')).events.filter((e) => e.event.kind === 'user_message')
    expect(messages.at(-1)?.event).toEqual({ kind: 'user_message', text: 'Thanks' })

    await vi.waitFor(async () => expect(await status(engine)).toBe('idle'))
    await engine.invoke('orchestrator.send', 'And now?')
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(2))
    expect(runtime.sent[1]).toMatch(/^\[Mainbus\] Workspace: repo .*\n\nAnd now\?$/)
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

  test('a message sent mid-turn does not become the intent of that turn’s proposals', async () => {
    const runtime = new FakeRuntime([], {
      orchestrator: [
        { emit: { kind: 'session', sessionId: 'sess-1' } },
        // The second message arrives while the first turn is still under way, and is queued as its own turn.
        { waitForSend: true },
        { callTool: 'proposeCreateTickets', args: { tickets: [{ title: 'From the first' }] } },
        turnEnd(),
        { waitForSend: true }
      ]
    })
    const { engine } = await makeEngine(runtime)
    await engine.invoke('orchestrator.send', 'First ask')
    await engine.invoke('orchestrator.send', 'Second ask')
    await vi.waitFor(async () => {
      const kinds = (await engine.invoke('orchestrator.get')).events.map((e) => e.event.kind)
      expect(kinds).toContain('turn_end')
    })
    // The second turn is now the current one.
    await (await liveTools(runtime)).proposeCreateTickets({ tickets: [{ title: 'From the second' }] })

    const proposals = (await engine.invoke('orchestrator.get')).proposals
    expect(proposals.map((p) => (p.payload as { intent: string }).intent)).toEqual(['First ask', 'Second ask'])
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
      new RegExp(`^\\[Mainbus\\] Since your last turn.*\\n- Proposal ${proposal!.id} \\(create tickets\\): changed by the user, then confirmed\\. Created #1 "Sign in" in Ready\\.\\n\\n\\[Mainbus\\] Workspace`)
    )
  })
})
