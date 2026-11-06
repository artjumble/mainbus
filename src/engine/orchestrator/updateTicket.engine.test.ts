import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { EngineEvent } from '../../shared/api'
import type { Ticket } from '../../shared/domain'
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
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-update-ticket-'))
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
/** A first turn that ends, then a second that stays open. */
const TWO_TURNS: FakeStep[] = [{ emit: { kind: 'session', sessionId: 'orch' } }, { emit: { kind: 'turn_end', ok: true } }, { waitForSend: true }]
const WORKING: FakeStep[] = [{ emit: { kind: 'session', sessionId: 'role-sess' } }, { waitForSend: true }]
const HANDOFF: FakeStep[] = [{ callTool: 'handoff', args: { summary: 'done', notesForNext: '' } }, { emit: { kind: 'turn_end', ok: true } }]

async function makeEngine(roles: FakeStep[] = WORKING, orchestrator: FakeStep[] = OPEN_TURN): Promise<{ engine: Engine; runtime: FakeRuntime; events: EngineEvent[] }> {
  const runtime = new FakeRuntime(roles, { orchestrator })
  const engine = await createEngine({ paths, migrationsDir, runtime, git: runGit, exec })
  engines.push(engine)
  await engine.invoke('workspace.open', repoPath)
  const events: EngineEvent[] = []
  engine.on((e) => events.push(e))
  return { engine, runtime, events }
}

const newTicket = (engine: Engine, column: 'backlog' | 'ready' = 'backlog'): Promise<Ticket> =>
  engine.invoke('ticket.create', {
    title: 'Login',
    intent: 'Add a login form',
    spec: 'A form\nRun settings section',
    criteria: ['form renders', 'Run settings shown', 'bad password rejected'],
    labels: ['auth'],
    column
  })

/** The live session's tools, once the first message has started it. */
async function liveTools(engine: Engine, runtime: FakeRuntime, first = 'Hello') {
  await engine.invoke('orchestrator.send', first)
  await vi.waitFor(() => expect(runtime.orchestratorSpecs).toHaveLength(1))
  return runtime.orchestratorSpecs[0]!.tools
}

const ticketOf = async (engine: Engine, id: string) => (await engine.invoke('board.get')).tickets.find((t) => t.id === id)!

describe('update_ticket', () => {
  test('replaces the title, spec, criteria and labels, keeps ticks of unchanged criteria, and leaves the words alone', async () => {
    const { engine, runtime, events } = await makeEngine()
    const t = await newTicket(engine)
    await engine.invoke('ticket.update', t.id, { criteria: t.criteria.map((c, i) => ({ ...c, checked: i !== 1 })) })
    const tools = await liveTools(engine, runtime)

    const answer = await tools.updateTicket({
      ticket: 1,
      title: 'Add login',
      spec: 'A form',
      criteria: ['form renders', 'bad password rejected', 'new one'],
      labels: ['auth', 'ui']
    })
    expect(answer).toBe(
      'Updated #1 "Add login" in repo: title, spec, criteria, labels. The user can Undo it. Tell the user what changed.'
    )
    const after = await ticketOf(engine, t.id)
    expect(after).toMatchObject({ title: 'Add login', spec: 'A form', labels: ['auth', 'ui'] })
    expect(after.criteria.map((c) => [c.text, c.checked])).toEqual([
      ['form renders', true],
      ['bad password rejected', true],
      ['new one', false]
    ])
    expect(after.intent).toEqual(t.intent)
    expect(events).toContainEqual({ type: 'board.changed', workspaceId: t.workspaceId })
    expect(events.find((e) => e.type === 'ticketEdit.changed')).toMatchObject({ edit: { fields: ['title', 'spec', 'criteria', 'labels'], intentAdded: [] } })

    const thread = await engine.invoke('orchestrator.get')
    expect(thread.events.at(-1)?.event).toMatchObject({ kind: 'ticket_edited', workspace: 'repo', ticket: { id: t.id, number: 1, title: 'Add login' } })
    expect(thread.edits).toHaveLength(1)
    expect(after.edits).toEqual([{ id: thread.edits[0]!.id, at: expect.any(String), fields: ['title', 'spec', 'criteria', 'labels'], userWords: 0, undoneAt: null }])
  })

  test('add_user_words appends this turn\'s message verbatim; with request_messages_back 1 it appends both', async () => {
    const { engine, runtime } = await makeEngine(WORKING, TWO_TURNS)
    const t = await newTicket(engine)
    const tools = await liveTools(engine, runtime, 'Make the title shorter')

    await tools.updateTicket({ ticket: 1, title: 'Login', add_user_words: true })
    expect((await ticketOf(engine, t.id)).intent.map((e) => [e.text, e.source, e.via])).toEqual([
      ['Add a login form', undefined, undefined],
      ['Make the title shorter', undefined, undefined]
    ])

    await vi.waitFor(async () => expect((await engine.invoke('orchestrator.get')).status).toBe('idle'))
    await engine.invoke('orchestrator.send', 'Drop the Run settings part')
    await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
    const answer = await tools.updateTicket({ ticket: 1, spec: 'A form', add_user_words: true, request_messages_back: 1 })
    expect(answer).toBe('Updated #1 "Login" in repo: spec, the user\'s words (+2). The user can Undo it. Tell the user what changed.')
    const intent = (await ticketOf(engine, t.id)).intent
    expect(intent.slice(-2).map((e) => e.text)).toEqual(['Make the title shorter', 'Drop the Run settings part'])
    expect(intent.slice(-2).every((e) => e.source === undefined && e.via === undefined)).toBe(true)
  })

  test("the orchestrator can't supply the words, or rewrite the intent", async () => {
    const { engine, runtime } = await makeEngine()
    const t = await newTicket(engine)
    const tools = await liveTools(engine, runtime)

    expect(await tools.updateTicket({ ticket: 1, intent: 'Everything is fine' })).toBe('Invalid: Unknown field: intent. Nothing was changed; fix it and try again.')
    expect(await tools.updateTicket({ ticket: 1, add_user_words: 'The user said so' })).toMatch(/^Invalid: add_user_words/)
    expect(await tools.updateTicket({ ticket: 1, add_user_words: false, title: 'X' })).toMatch(/^Invalid: add_user_words/)
    expect(await tools.updateTicket({ ticket: 1, title: 'X', request_messages_back: 1 })).toBe(
      'Invalid: request_messages_back: only with add_user_words. Nothing was changed; fix it and try again.'
    )
    expect(await tools.updateTicket({ ticket: 1, title: 'X', add_user_words: true, request_messages_back: 3 })).toMatch(/^Invalid: request_messages_back: there is no earlier message of the user/)
    expect(await ticketOf(engine, t.id)).toMatchObject({ title: 'Login', intent: t.intent })
  })

  test('refuses what is invalid, unknown or a no-op, changing nothing', async () => {
    const { engine, runtime } = await makeEngine()
    const t = await newTicket(engine)
    const tools = await liveTools(engine, runtime)
    const nothing = ' Nothing was changed; fix it and try again.'

    expect(await tools.updateTicket({ ticket: 1, title: '   ' })).toBe(`Invalid: title: must not be blank.${nothing}`)
    expect(await tools.updateTicket({ ticket: 1, title: 'two\nlines' })).toBe(`Invalid: title: must be a single line.${nothing}`)
    expect(await tools.updateTicket({ ticket: 1, title: '' })).toMatch(/^Invalid: title: /)
    expect(await tools.updateTicket({ ticket: 1, criteria: Array.from({ length: 51 }, (_, i) => `c${i}`) })).toMatch(/^Invalid: criteria: must have at most 50 items/)
    expect(await tools.updateTicket({ ticket: 1, labels: [''] })).toMatch(/^Invalid: labels\.0: /)
    expect(await tools.updateTicket({ ticket: 1, color: 'red' })).toBe(`Invalid: Unknown field: color.${nothing}`)
    expect(await tools.updateTicket({ ticket: 1 })).toBe(`Invalid: Nothing to change: the ticket already has these values.${nothing}`)
    expect(await tools.updateTicket({ ticket: 1, title: 'Login', spec: t.spec, labels: ['auth'] })).toMatch(/^Invalid: Nothing to change/)
    expect(await tools.updateTicket({ ticket: 9, title: 'X' })).toBe('There is no ticket #9 in repo. Nothing was changed.')
    expect(await ticketOf(engine, t.id)).toMatchObject({ title: 'Login', spec: t.spec, updatedAt: t.updatedAt })
    expect((await engine.invoke('orchestrator.get')).edits).toEqual([])
  })

  test('works on Backlog, Ready, and Review with an ended run', async () => {
    const { engine, runtime } = await makeEngine(HANDOFF)
    const backlog = await newTicket(engine, 'backlog')
    const ready = await newTicket(engine, 'ready')
    const review = await newTicket(engine, 'ready')
    await engine.invoke('agent.start', review.id)
    await vi.waitFor(async () => expect((await ticketOf(engine, review.id)).state.column).toBe('review'), { timeout: 10_000 })
    const tools = await liveTools(engine, runtime)

    for (const t of [backlog, ready, review]) {
      expect(await tools.updateTicket({ ticket: t.number, title: `New ${t.number}` })).toMatch(/^Updated #/)
      expect((await ticketOf(engine, t.id)).title).toBe(`New ${t.number}`)
    }
  })

  test('refuses a running ticket, one that failed, and a Done one, with the reason', async () => {
    const { engine, runtime } = await makeEngine(WORKING)
    const running = await newTicket(engine, 'ready')
    const done = await newTicket(engine)
    await engine.invoke('ticket.move', done.id, 'done')
    await engine.invoke('agent.start', running.id)
    await vi.waitFor(async () => expect((await ticketOf(engine, running.id)).state.column).toBe('in_progress'))
    const tools = await liveTools(engine, runtime)

    expect(await tools.updateTicket({ ticket: running.number, title: 'Other' })).toBe(
      '#1 has a run open, and editing it would change what its agents were given without telling them. Tell the user to stop the run first, or to let it finish. Nothing was changed.'
    )
    expect(await tools.updateTicket({ ticket: done.number, title: 'Other' })).toBe("#2 is Done, and Done tickets can't be edited. Nothing was changed.")
    expect((await ticketOf(engine, running.id)).title).toBe('Login')
    expect((await ticketOf(engine, done.id)).title).toBe('Login')
  })

  test('the workspace is required with two open, and resolves with one', async () => {
    const { engine, runtime } = await makeEngine()
    const t = await newTicket(engine)
    await engine.invoke('workspace.open', await makeRepo(path.join(tmp, 'website')))
    const repo = (await engine.invoke('workspace.list')).find((w) => w.name === 'repo')!
    await engine.invoke('workspace.focus', repo.id)
    const tools = await liveTools(engine, runtime)

    expect(await tools.updateTicket({ ticket: 1, title: 'Two' })).toMatch(/^More than one workspace is open: .*Nothing was changed.$/)
    expect(await tools.updateTicket({ workspace: 'nowhere', ticket: 1, title: 'Two' })).toMatch(/^No workspace "nowhere"./)
    expect((await ticketOf(engine, t.id)).title).toBe('Login')
    expect(await tools.updateTicket({ workspace: 'repo', ticket: 1, title: 'Two' })).toMatch(/^Updated #1 "Two" in repo/)
    expect((await ticketOf(engine, t.id)).title).toBe('Two')
  })

  test('with one workspace open, it may be left out', async () => {
    const { engine, runtime } = await makeEngine()
    await newTicket(engine)
    const tools = await liveTools(engine, runtime)
    expect(await tools.updateTicket({ ticket: 1, title: 'Alone' })).toMatch(/^Updated #1 "Alone" in repo/)
  })
})

describe('Undo', () => {
  async function edited() {
    const made = await makeEngine()
    const t = await newTicket(made.engine)
    await made.engine.invoke('ticket.update', t.id, { criteria: t.criteria.map((c) => ({ ...c, checked: c.position === 0 })) })
    await made.engine.invoke('ticket.appendIntent', t.id, 'An earlier addition')
    const before = await ticketOf(made.engine, t.id)
    const tools = await liveTools(made.engine, made.runtime, 'Drop the Run settings part')
    await tools.updateTicket({
      ticket: 1,
      title: 'Login v2',
      spec: 'A form',
      criteria: ['form renders', 'bad password rejected'],
      labels: [],
      add_user_words: true
    })
    const [edit] = (await made.engine.invoke('orchestrator.get')).edits
    return { ...made, t, before, edit: edit!, tools }
  }

  test('puts every field back as it was and removes only the intent this edit appended', async () => {
    const { engine, events, t, before, edit } = await edited()
    const during = await ticketOf(engine, t.id)
    expect(during.intent.map((e) => e.text)).toEqual(['Add a login form', 'An earlier addition', 'Drop the Run settings part'])

    const undone = await engine.invoke('ticket.undoEdit', edit.id)
    expect(undone.undoneAt).toEqual(expect.any(String))
    const after = await ticketOf(engine, t.id)
    expect(after.title).toBe(before.title)
    expect(after.spec).toBe(before.spec)
    expect(after.labels).toEqual(before.labels)
    expect(after.criteria).toEqual(before.criteria)
    expect(after.intent).toEqual(before.intent)
    expect(after.edits).toEqual([expect.objectContaining({ id: edit.id, undoneAt: undone.undoneAt })])
    expect(events.filter((e) => e.type === 'ticketEdit.changed')).toHaveLength(2)
    expect((await engine.invoke('orchestrator.get')).edits[0]!.undoneAt).toBe(undone.undoneAt)

    await expect(engine.invoke('ticket.undoEdit', edit.id)).rejects.toThrow('already undone')
  })

  test('is refused after a later change to the ticket, changing nothing', async () => {
    const { engine, t, edit } = await edited()
    await engine.invoke('ticket.update', t.id, { title: 'Changed by hand' })
    await expect(engine.invoke('ticket.undoEdit', edit.id)).rejects.toThrow("Can't undo: #1 has changed since this edit, so it can't be undone")
    expect((await ticketOf(engine, t.id)).title).toBe('Changed by hand')
  })

  test('is refused after more words were added, leaving the edit as it is', async () => {
    const { engine, t, edit } = await edited()
    await engine.invoke('ticket.appendIntent', t.id, 'More words')
    await expect(engine.invoke('ticket.undoEdit', edit.id)).rejects.toThrow('has changed since this edit')
    expect((await ticketOf(engine, t.id)).intent.map((e) => e.text)).toEqual(['Add a login form', 'An earlier addition', 'Drop the Run settings part', 'More words'])
    expect((await engine.invoke('orchestrator.get')).edits[0]!.undoneAt).toBeNull()
  })

  test('is refused once the ticket has started', async () => {
    const { engine, t, edit } = await edited()
    await engine.invoke('ticket.move', t.id, 'ready')
    await engine.invoke('agent.start', t.id)
    await vi.waitFor(async () => expect((await ticketOf(engine, t.id)).state.column).toBe('in_progress'))
    await expect(engine.invoke('ticket.undoEdit', edit.id)).rejects.toThrow("Can't undo: #1 has a run open")
    expect((await ticketOf(engine, t.id)).title).toBe('Login v2')
  })
})
