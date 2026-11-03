import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent } from '../../shared/api'
import { FakeRuntime } from '../runtime/fakeRuntime'
import { createIntakeHandler, IntakeFailure, isInside } from './methods'
import { makeTestBoard, type TestBoard } from './testBoard'

let boards: TestBoard[] = []

async function board(options?: Parameters<typeof makeTestBoard>[0]): Promise<TestBoard> {
  const b = await makeTestBoard(options)
  boards.push(b)
  // Every request names the caller's folder, which must be inside a workspace: here, the board's repo.
  source.cwd = b.repoPath
  return b
}

afterEach(async () => {
  for (const b of boards) await b.dispose()
  boards = []
})

const source = { agent: 'codex', cwd: 'C:\\work\\elsewhere' }
const valid = { title: 'Flaky test in CI', intent: 'The login test fails one run in ten.', source }

async function failure(promise: Promise<unknown>): Promise<IntakeFailure> {
  const error = await promise.then(
    () => {
      throw new Error('expected the request to fail')
    },
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(IntakeFailure)
  return error as IntakeFailure
}

describe('intake create', () => {
  it('creates the ticket in Backlog through ticket.create, marks the agent and emits board.changed', async () => {
    const { engine } = await board()
    const seen: EngineEvent[] = []
    engine.on((e) => seen.push(e))

    const created = await engine.intake('create', {
      ...valid,
      spec: 'Look at the retry logic.',
      criteria: ['Passes 50 runs in a row'],
      labels: ['ci']
    })
    expect(created).toEqual({ number: 1, title: 'Flaky test in CI', column: 'backlog' })

    const [ticket] = (await engine.invoke('board.get')).tickets
    expect(ticket).toMatchObject({
      number: 1,
      title: 'Flaky test in CI',
      spec: 'Look at the retry logic.',
      labels: ['ci'],
      manualColumn: 'backlog',
      criteria: [{ position: 0, text: 'Passes 50 runs in a row', checked: false }],
      state: { column: 'backlog', phase: 'not_started' }
    })
    expect(ticket!.intent).toEqual([
      { text: valid.intent, at: expect.any(String), source: { kind: 'agent', agent: 'codex', cwd: source.cwd } }
    ])
    expect(seen).toContainEqual({ type: 'board.changed', workspaceId: ticket!.workspaceId })
  })

  it("leaves the user's own tickets and later words without a source", async () => {
    const { engine } = await board()
    // Even if the renderer sent a source, ticket.create would drop it.
    const input = { title: 'Mine', intent: 'My words', spec: '', criteria: [], labels: [], column: 'ready' as const }
    const mine = await engine.invoke('ticket.create', { ...input, source: { kind: 'agent', agent: 'x', cwd: '' } } as typeof input)
    expect(mine.intent[0]).not.toHaveProperty('source')
    // Nor is it marked as the orchestrator's, or given words the user didn't type in it.
    const marked = await engine.invoke('ticket.create', {
      ...input,
      via: 'orchestrator',
      intentAdded: [{ text: 'Not mine', at: '2026-01-01T00:00:00.000Z' }]
    } as typeof input)
    expect(marked.intent).toEqual([{ text: 'My words', at: expect.any(String) }])

    await engine.intake('create', valid)
    const agentTicket = (await engine.invoke('board.get')).tickets.find((t) => t.number === 3)!
    const appended = await engine.invoke('ticket.appendIntent', agentTicket.id, 'My addition')
    expect(appended.intent[0]!.source?.agent).toBe('codex')
    expect(appended.intent[1]).not.toHaveProperty('source')
  })

  it.each([
    ['a column', { ...valid, column: 'ready' }, 'column'],
    ['an unknown field', { ...valid, priority: 'high' }, 'priority'],
    ['an unknown source field', { ...valid, source: { ...source, verified: true } }, 'source.verified'],
    ['a missing title', { intent: valid.intent, source }, 'title'],
    ['an empty title', { ...valid, title: '' }, 'title'],
    ['a multi-line title', { ...valid, title: 'one\ntwo' }, 'title'],
    ['a 201-character title', { ...valid, title: 'x'.repeat(201) }, 'title'],
    ['an empty intent', { ...valid, intent: '' }, 'intent'],
    ['an oversized intent', { ...valid, intent: 'x'.repeat(20_001) }, 'intent'],
    ['an oversized spec', { ...valid, spec: 'x'.repeat(100_001) }, 'spec'],
    ['too many criteria', { ...valid, criteria: Array.from({ length: 51 }, () => 'c') }, 'criteria'],
    ['an oversized criterion', { ...valid, criteria: ['ok', 'x'.repeat(1_001)] }, 'criteria.1'],
    ['an empty criterion', { ...valid, criteria: [''] }, 'criteria.0'],
    ['too many labels', { ...valid, labels: Array.from({ length: 21 }, () => 'l') }, 'labels'],
    ['an oversized label', { ...valid, labels: ['x'.repeat(51)] }, 'labels.0'],
    ['a missing source', { title: valid.title, intent: valid.intent }, 'source'],
    ['an empty agent', { ...valid, source: { ...source, agent: '' } }, 'source.agent'],
    ['an oversized agent', { ...valid, source: { ...source, agent: 'x'.repeat(101) } }, 'source.agent'],
    ['an oversized cwd', { ...valid, source: { ...source, cwd: 'x'.repeat(1_001) } }, 'source.cwd'],
    ['a relative repo', { ...valid, repo: 'repo' }, 'repo'],
    ['a title of the wrong type', { ...valid, title: 7 }, 'title']
  ])('rejects %s, naming the field, and creates nothing', async (_, params, field) => {
    const { engine } = await board()
    const error = await failure(engine.intake('create', params))
    expect(error.code).toBe('invalid')
    expect(error.field).toBe(field)
    expect(error.message).toContain(field)
    expect((await engine.invoke('board.get')).tickets).toEqual([])
  })

  it('accepts the limits themselves', async () => {
    const { engine, repoPath } = await board()
    await engine.intake('create', {
      title: 'x'.repeat(200),
      intent: 'x'.repeat(20_000),
      spec: 'x'.repeat(100_000),
      criteria: Array.from({ length: 50 }, () => 'x'.repeat(1_000)),
      labels: Array.from({ length: 20 }, () => 'x'.repeat(50)),
      repo: repoPath,
      source: { agent: 'x'.repeat(100), cwd: 'x'.repeat(1_000) }
    })
    expect((await engine.invoke('board.get')).tickets).toHaveLength(1)
  })

  it('accepts the open workspace or a folder inside it as repo, and rejects any other folder as workspace_mismatch', async () => {
    const { engine, repoPath, tmp } = await board()
    await engine.intake('create', { ...valid, repo: repoPath })
    await engine.intake('create', { ...valid, repo: `${repoPath}${path.sep}` })
    await engine.intake('create', { ...valid, repo: path.join(repoPath, 'src', 'deep') })
    if (process.platform === 'win32') await engine.intake('create', { ...valid, repo: path.join(repoPath, 'Src').toUpperCase() })

    for (const outside of [path.join(tmp, 'other'), tmp, `${repoPath}-sibling`, path.join(repoPath, '..', 'other')]) {
      const error = await failure(engine.intake('create', { ...valid, repo: outside }))
      expect(error, outside).toMatchObject({ code: 'workspace_mismatch', field: 'repo' })
    }
    expect((await engine.invoke('board.get')).tickets).toHaveLength(process.platform === 'win32' ? 4 : 3)
  })

  it('answers no_workspace when no workspace is open', async () => {
    const { engine } = await board({ openWorkspace: false })
    expect((await failure(engine.intake('create', valid))).code).toBe('no_workspace')
    expect((await failure(engine.intake('list', { cwd: source.cwd }))).code).toBe('no_workspace')
  })
})

describe('intake list and get', () => {
  it('lists the workspace tickets with status and source, optionally by column', async () => {
    const { engine } = await board()
    await engine.invoke('ticket.create', { title: 'Mine', intent: 'mine', spec: '', criteria: [], labels: ['ui'], column: 'ready' })
    await engine.intake('create', valid)

    const all = await engine.intake('list', { cwd: source.cwd })
    expect(all.tickets).toEqual([
      {
        number: 1,
        title: 'Mine',
        column: 'ready',
        phase: 'not_started',
        agentStatus: null,
        labels: ['ui'],
        source: null,
        prUrl: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String)
      },
      expect.objectContaining({ number: 2, column: 'backlog', source: { kind: 'agent', ...source } })
    ])
    expect((await engine.intake('list', { cwd: source.cwd, column: 'backlog' })).tickets.map((t) => t.number)).toEqual([2])
    expect((await engine.intake('list', { cwd: source.cwd })).tickets).toHaveLength(2)
    expect(await failure(engine.intake('list', { cwd: source.cwd, column: 'nowhere' }))).toMatchObject({ code: 'invalid', field: 'column' })
  })

  it('gets a ticket by number with every intent entry and its source', async () => {
    const { engine } = await board()
    await engine.intake('create', { ...valid, spec: 'S', criteria: ['A', 'B'], labels: ['ci'] })
    const id = (await engine.invoke('board.get')).tickets[0]!.id
    await engine.invoke('ticket.update', id, {
      criteria: [
        { position: 0, text: 'A', checked: true },
        { position: 1, text: 'B', checked: false }
      ]
    })
    await engine.invoke('ticket.appendIntent', id, 'User addition')

    expect(await engine.intake('get', { cwd: source.cwd, number: 1 })).toEqual({
      number: 1,
      title: valid.title,
      column: 'backlog',
      phase: 'not_started',
      agentStatus: null,
      intent: [
        { text: valid.intent, at: expect.any(String), source: { kind: 'agent', ...source } },
        { text: 'User addition', at: expect.any(String), source: null }
      ],
      spec: 'S',
      criteria: [
        { text: 'A', checked: true },
        { text: 'B', checked: false }
      ],
      labels: ['ci'],
      prUrl: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String)
    })
    expect(await failure(engine.intake('get', { cwd: source.cwd, number: 9 }))).toMatchObject({ code: 'not_found', field: 'number' })
    expect(await failure(engine.intake('get', { cwd: source.cwd, number: 'one' }))).toMatchObject({ code: 'invalid', field: 'number' })
  })

  it('never returns thread events, decisions or allow rules', async () => {
    const { engine } = await board({
      runtime: new FakeRuntime([
        { emit: { kind: 'message', text: 'SECRET-THREAD-TEXT' } },
        { callTool: 'askUser', args: { question: 'SECRET-DECISION-QUESTION', options: ['SECRET-OPTION', 'B'] } }
      ])
    })
    await engine.intake('create', valid)
    const id = (await engine.invoke('board.get')).tickets[0]!.id
    await engine.invoke('ticket.move', id, 'ready')
    await engine.invoke('agent.start', id)
    await vi.waitFor(async () => expect((await engine.invoke('thread.get', id)).decisions).toHaveLength(1))
    expect((await engine.invoke('board.get')).tickets[0]!.state.summary).toBe('SECRET-DECISION-QUESTION')

    const replies = JSON.stringify([await engine.intake('list', { cwd: source.cwd }), await engine.intake('get', { cwd: source.cwd, number: 1 })])
    expect(replies).not.toMatch(/SECRET|decision|events|allow|runId|branch|worktree/i)
    expect(await engine.intake('get', { cwd: source.cwd, number: 1 })).toMatchObject({ column: 'needs_you', agentStatus: 'waiting_on_you' })
  })

  it('get loads only the requested ticket', async () => {
    const ws = { id: 'w', name: 'repo', repoPath: '/r' } as Parameters<Parameters<typeof createIntakeHandler>[0]['ticket']>[0]
    const ticket = vi.fn(async () => null)
    const tickets = vi.fn(async () => {
      throw new Error('get must not load the whole board')
    })
    const handle = createIntakeHandler({ workspaces: async () => [ws], ticketFolders: () => '/none', createTicket: vi.fn(), tickets, ticket })
    expect(await failure(handle('get', { cwd: '/r', number: 3 }))).toMatchObject({ code: 'not_found' })
    expect(ticket).toHaveBeenCalledWith(ws, 3)
    expect(tickets).not.toHaveBeenCalled()
  })

  it('list and get return the pull request URL once there is one', async () => {
    const ws = { id: 'w', name: 'repo', repoPath: '/r' } as Parameters<Parameters<typeof createIntakeHandler>[0]['ticket']>[0]
    const state = { column: 'review', phase: 'ready_for_review', agentStatus: 'handed_off', summary: null, canContinue: false } as const
    const ticket = {
      number: 4,
      title: 'T',
      intent: [],
      spec: '',
      criteria: [],
      labels: [],
      pr: { url: 'https://github.com/o/r/pull/9', number: 9 },
      createdAt: 'c',
      updatedAt: 'u',
      state
    } as unknown as Awaited<ReturnType<Parameters<typeof createIntakeHandler>[0]['ticket']>> & object
    const handle = createIntakeHandler({
      workspaces: async () => [ws],
      ticketFolders: () => '/none',
      createTicket: vi.fn(),
      tickets: async () => [ticket],
      ticket: async () => ticket
    })
    expect((await handle('list', { cwd: '/r' })).tickets[0]).toMatchObject({ prUrl: 'https://github.com/o/r/pull/9' })
    expect(await handle('get', { cwd: '/r', number: 4 })).toMatchObject({ prUrl: 'https://github.com/o/r/pull/9' })
  })

  it('rejects unknown methods', async () => {
    const { engine } = await board()
    const error = await failure(engine.intake('delete' as 'get', { number: 1 }))
    expect(error.code).toBe('unknown_method')
  })

  it.each(['openPr', 'ticket.openPr', 'push', 'setOpenPrOnReview', 'workspace.setOpenPrOnReview'])(
    'has no way to make Mainbus push: %s is unknown',
    async (method) => {
      const { engine } = await board()
      expect((await failure(engine.intake(method as 'get', { number: 1 }))).code).toBe('unknown_method')
    }
  )
})

describe('isInside', () => {
  it('compares Windows paths case-insensitively, and never matches a sibling with the same prefix', () => {
    expect(isInside('C:\\Repo', 'c:\\repo', 'win32')).toBe(true)
    expect(isInside('c:\\repo\\SRC\\x', 'C:\\Repo\\', 'win32')).toBe(true)
    expect(isInside('C:\\Repo-2', 'C:\\Repo', 'win32')).toBe(false)
    expect(isInside('C:\\', 'C:\\Repo', 'win32')).toBe(false)
    expect(isInside('D:\\Repo', 'C:\\Repo', 'win32')).toBe(false)
    expect(isInside('/repo/..x', '/repo', 'linux')).toBe(true)
    expect(isInside('/Repo', '/repo', 'linux')).toBe(false)
  })
})
