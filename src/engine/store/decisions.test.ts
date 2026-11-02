import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db/open'
import { createDecisionRepo } from './decisions'
import { createRunRepo } from './runs'
import { FIXED_NOW, openTestDb, testRole } from './testDb'
import { createTicketRepo } from './tickets'
import { createWorkspaceRepo } from './workspaces'

let db: Db
let cleanup: () => void
let ticketId: string
let runId: string
let clock: Date
const now = () => clock

beforeEach(async () => {
  ;({ db, cleanup } = await openTestDb())
  clock = FIXED_NOW
  const ws = await createWorkspaceRepo(db, now).create('/r', 'main', 'r', 'r')
  ticketId = (
    await createTicketRepo(db, now).create({
      workspaceId: ws.id,
      title: 'T',
      intent: 'i',
      spec: '',
      criteria: [],
      labels: [],
      column: 'ready'
    })
  ).id
  runId = await createRunRepo(db, now).create(ticketId, [testRole()])
})
afterEach(() => cleanup())

const question = () =>
  ({
    ticketId,
    agentRunId: runId,
    kind: 'question',
    question: 'Which database?',
    options: ['SQLite', 'Postgres'],
    recommended: 0,
    allowAlways: true
  }) as const

describe('decision repo', () => {
  it('opens a pending decision', async () => {
    const repo = createDecisionRepo(db, now)
    const d = await repo.open({ ...question(), options: [...question().options] })
    expect(d).toEqual({
      id: expect.any(String),
      ...question(),
      options: ['SQLite', 'Postgres'],
      status: 'pending',
      answer: null,
      createdAt: FIXED_NOW.toISOString(),
      answeredAt: null,
      answeredBy: null,
      answeredVia: null
    })
    expect(await repo.get(d.id)).toEqual(d)
    expect(await repo.actionOf(d.id)).toBeNull()
  })

  it('keeps the action Mainbus takes on the answer, apart from the decision', async () => {
    const repo = createDecisionRepo(db, now)
    const action = { kind: 'problem', fromRoleId: 'r', toRoleId: 'i', details: 'Tests fail' } as const
    const d = await repo.open({ ...question(), options: ['Hand back to Implementer', 'Keep going'] }, action)
    expect(await repo.actionOf(d.id)).toEqual(action)
    expect(d).not.toHaveProperty('action')
    await expect(repo.actionOf('missing')).rejects.toThrow(/not found/)
  })

  it('stores a null recommendation and allowAlways false', async () => {
    const repo = createDecisionRepo(db, now)
    const d = await repo.open({
      ...question(),
      kind: 'permission',
      options: ['Allow once', 'Always allow', 'Deny'],
      recommended: null,
      allowAlways: false
    })
    const got = await repo.get(d.id)
    expect(got.recommended).toBeNull()
    expect(got.allowAlways).toBe(false)
    expect(got.kind).toBe('permission')
  })

  it('answers a decision', async () => {
    const repo = createDecisionRepo(db, now)
    const d = await repo.open({ ...question(), options: [...question().options] })
    clock = new Date('2026-10-30T12:05:00.000Z')
    const answered = await repo.answer(d.id, { kind: 'option', index: 1, note: 'team uses it' }, 'board')
    expect(answered).toMatchObject({
      status: 'answered',
      answer: { kind: 'option', index: 1, note: 'team uses it' },
      answeredAt: '2026-10-30T12:05:00.000Z',
      answeredBy: 'user',
      answeredVia: 'board'
    })
    expect(await repo.get(d.id)).toEqual(answered)
  })

  it('a pending decision has no answerer yet', async () => {
    const repo = createDecisionRepo(db, now)
    const d = await repo.open({ ...question(), options: [...question().options] })
    expect(d).toMatchObject({ answeredBy: null, answeredVia: null })
  })

  it('answering a decision twice throws, naming where the first answer came from', async () => {
    const repo = createDecisionRepo(db, now)
    const d = await repo.open({ ...question(), options: [...question().options] })
    await repo.answer(d.id, { kind: 'option', index: 0 }, 'board')
    await expect(repo.answer(d.id, { kind: 'option', index: 1 }, 'thread')).rejects.toThrow('Already answered from the board')
    await expect(repo.answer(d.id, { kind: 'option', index: 1 }, 'board')).rejects.toThrow('Already answered from the board')
    const kept = await repo.get(d.id)
    expect(kept.answer).toEqual({ kind: 'option', index: 0 })
    expect(kept.answeredVia).toBe('board')
  })

  it('answering an expired decision throws', async () => {
    const repo = createDecisionRepo(db, now)
    const d = await repo.open({ ...question(), options: [...question().options] })
    await repo.expire(d.id)
    await expect(repo.answer(d.id, { kind: 'option', index: 0 }, 'thread')).rejects.toThrow(/pending/i)
  })

  it('expires a pending decision', async () => {
    const repo = createDecisionRepo(db, now)
    const d = await repo.open({ ...question(), options: [...question().options] })
    const expired = await repo.expire(d.id)
    expect(expired.status).toBe('expired')
    expect(expired.answer).toBeNull()
  })

  it('pending returns only pending decisions for the ticket', async () => {
    const repo = createDecisionRepo(db, now)
    const base = { ...question(), options: [...question().options] }
    const first = await repo.open(base)
    const second = await repo.open({ ...base, question: 'Which ORM?' })
    const third = await repo.open({ ...base, question: 'Which port?' })
    await repo.answer(first.id, { kind: 'option', index: 0 }, 'thread')
    await repo.expire(third.id)

    expect((await repo.pending(ticketId)).map((d) => d.id)).toEqual([second.id])
    expect(await repo.pending('other-ticket')).toEqual([])
  })

  it('forTicket returns every decision of the ticket, whatever its status, in the order opened', async () => {
    const repo = createDecisionRepo(db, now)
    const base = { ...question(), options: [...question().options] }
    const first = await repo.open(base)
    const second = await repo.open({ ...base, question: 'Which ORM?' })
    const third = await repo.open({ ...base, question: 'Which port?' })
    await repo.answer(first.id, { kind: 'option', index: 0 }, 'thread')
    await repo.expire(third.id)

    const all = await repo.forTicket(ticketId)
    expect(all.map((d) => [d.id, d.status])).toEqual([
      [first.id, 'answered'],
      [second.id, 'pending'],
      [third.id, 'expired']
    ])
    expect(await repo.forTicket('other-ticket')).toEqual([])
  })

  it('throws for an unknown decision', async () => {
    await expect(createDecisionRepo(db, now).get('missing')).rejects.toThrow(/decision/i)
  })

  it('lists the decisions answered since a time, with their ticket', async () => {
    const repo = createDecisionRepo(db, now)
    const a = await repo.open({ ...question(), options: ['SQLite', 'Postgres'] })
    const b = await repo.open({ ...question(), options: ['SQLite', 'Postgres'] })
    await repo.open({ ...question(), options: ['SQLite', 'Postgres'] })
    const ws = (await createWorkspaceRepo(db, now).get())!
    await repo.answer(a.id, { kind: 'option', index: 0 }, 'board')
    clock = new Date(FIXED_NOW.getTime() + 1000)
    await repo.answer(b.id, { kind: 'option', index: 1 }, 'orchestrator')
    const all = await repo.answeredSince(ws.id, null)
    expect(all.map((x) => [x.number, x.title, x.decision.answeredVia])).toEqual([
      [1, 'T', 'board'],
      [1, 'T', 'orchestrator']
    ])
    expect((await repo.answeredSince(ws.id, clock.toISOString())).map((x) => x.decision.id)).toEqual([b.id])
    expect(await repo.answeredSince('other', null)).toEqual([])
  })
})
