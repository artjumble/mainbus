import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db/open'
import { createRunRepo } from './runs'
import { FIXED_NOW, openTestDb } from './testDb'
import { createTicketRepo } from './tickets'
import { createWorkspaceRepo } from './workspaces'

let db: Db
let cleanup: () => void
let ticketId: string
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
})
afterEach(() => cleanup())

describe('run repo', () => {
  it('has no latest run before one is created', async () => {
    expect(await createRunRepo(db, now).latest(ticketId)).toBeNull()
  })

  it('creates a run and returns it as the latest', async () => {
    const repo = createRunRepo(db, now)
    const runId = await repo.create(ticketId, 'Implementer', 'opus', 'high')
    expect(await repo.latest(ticketId)).toEqual({
      id: runId,
      ticketId,
      role: 'Implementer',
      sessionId: null,
      endReason: null,
      startedAt: FIXED_NOW.toISOString(),
      endedAt: null
    })
  })

  it('latest is the most recently started run', async () => {
    const repo = createRunRepo(db, now)
    const first = await repo.create(ticketId, 'Implementer', null, null)
    clock = new Date('2026-10-30T13:00:00.000Z')
    const second = await repo.create(ticketId, 'Implementer', null, null)
    expect(first).not.toBe(second)
    expect((await repo.latest(ticketId))?.id).toBe(second)
  })

  it('latest breaks a same-instant tie by creation order', async () => {
    const repo = createRunRepo(db, now)
    await repo.create(ticketId, 'Implementer', null, null)
    const second = await repo.create(ticketId, 'Implementer', null, null)
    expect((await repo.latest(ticketId))?.id).toBe(second)
  })

  it('listForTicket lists every run of the ticket, oldest first', async () => {
    const repo = createRunRepo(db, now)
    expect(await repo.listForTicket(ticketId)).toEqual([])
    clock = new Date('2026-10-30T13:00:00.000Z')
    const second = await repo.create(ticketId, 'Implementer', null, null)
    clock = FIXED_NOW
    const first = await repo.create(ticketId, 'Implementer', null, null)
    // Same instant as `first`: creation order breaks the tie.
    const firstTie = await repo.create(ticketId, 'Implementer', null, null)
    await repo.end(first, 'handoff')

    const runs = await repo.listForTicket(ticketId)
    expect(runs.map((r) => r.id)).toEqual([first, firstTie, second])
    expect(runs[0]).toMatchObject({ ticketId, role: 'Implementer', endReason: 'handoff' })
  })

  it('records the session and how the run ended', async () => {
    const repo = createRunRepo(db, now)
    const runId = await repo.create(ticketId, 'Implementer', null, null)
    await repo.setSession(runId, 'sess-1')
    clock = new Date('2026-10-30T12:30:00.000Z')
    await repo.end(runId, 'handoff')
    expect(await repo.latest(ticketId)).toMatchObject({
      sessionId: 'sess-1',
      endReason: 'handoff',
      endedAt: '2026-10-30T12:30:00.000Z'
    })
  })

  it('end only ends an open run: the first caller wins', async () => {
    const repo = createRunRepo(db, now)
    const runId = await repo.create(ticketId, 'Implementer', null, null)

    expect(await repo.end(runId, 'stopped')).toBe(true)
    clock = new Date('2026-10-30T12:45:00.000Z')
    expect(await repo.end(runId, 'handoff')).toBe(false)

    expect(await repo.latest(ticketId)).toMatchObject({ endReason: 'stopped', endedAt: '2026-10-30T12:00:00.000Z' })
  })

  it('events get consecutive seq numbers per run', async () => {
    const repo = createRunRepo(db, now)
    const a = await repo.create(ticketId, 'Implementer', null, null)
    const b = await repo.create(ticketId, 'Implementer', null, null)

    const a1 = await repo.append(a, { kind: 'message', text: 'hello' })
    const a2 = await repo.append(a, { kind: 'tool_call', id: 'c1', name: 'Bash', input: { command: 'ls' } })
    const b1 = await repo.append(b, { kind: 'stopped' })
    const a3 = await repo.append(a, { kind: 'turn_end', ok: true })

    expect([a1.seq, a2.seq, a3.seq]).toEqual([1, 2, 3])
    expect(b1.seq).toBe(1)
    expect(a1).toEqual({ runId: a, seq: 1, at: FIXED_NOW.toISOString(), event: { kind: 'message', text: 'hello' } })

    const stored = await repo.events(a)
    expect(stored.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(stored[1].event).toEqual({ kind: 'tool_call', id: 'c1', name: 'Bash', input: { command: 'ls' } })
    expect((await repo.events(b)).map((e) => e.seq)).toEqual([1])
  })

  it('concurrent appends still get distinct consecutive seq numbers', async () => {
    const repo = createRunRepo(db, now)
    const runId = await repo.create(ticketId, 'Implementer', null, null)
    const stored = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => repo.append(runId, { kind: 'message', text: `m${n}` }))
    )
    expect(stored.map((e) => e.seq).sort()).toEqual([1, 2, 3, 4, 5])
    expect((await repo.events(runId)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('events of an unknown run are empty', async () => {
    expect(await createRunRepo(db, now).events('missing')).toEqual([])
  })
})
