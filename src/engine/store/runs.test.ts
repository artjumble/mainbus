import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db/open'
import { createRunRepo } from './runs'
import { FIXED_NOW, openTestDb, testRole } from './testDb'
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
    const runId = await repo.create(ticketId, [testRole({ model: 'opus', effort: 'high' })])
    const latest = await repo.latest(ticketId)
    expect(latest).toEqual({
      id: runId,
      ticketId,
      ticketRunId: expect.any(String),
      roleId: 'implementer',
      role: 'Implementer',
      sessionId: null,
      endReason: null,
      startedAt: FIXED_NOW.toISOString(),
      endedAt: null,
      returnToRoleId: null,
      skipped: false,
      processPid: null,
      processStartedAt: null,
      declaredWait: null
    })
  })

  it('handOn and end mark the run they end as skipped only when asked', async () => {
    const repo = createRunRepo(db, now)
    const next = testRole({ id: 'r', name: 'Reviewer' })
    const first = await repo.create(ticketId, [testRole(), next])
    const second = (await repo.handOn(first, next, { skipped: true }))!
    expect(second.skipped).toBe(false)
    expect(await repo.end(second.id, 'handoff', { skipped: true })).toBe(true)
    expect((await repo.listForTicket(ticketId)).map((r) => [r.endReason, r.skipped])).toEqual([
      ['handoff', true],
      ['handoff', true]
    ])

    const plain = await repo.create(ticketId, [testRole(), next])
    const after = (await repo.handOn(plain, next))!
    await repo.end(after.id, 'handoff')
    const runs = await repo.listForTicketRun(after.ticketRunId)
    expect(runs.map((r) => r.skipped)).toEqual([false, false])
  })

  it("create starts a ticket run holding a copy of its roles, and the first role's run", async () => {
    const repo = createRunRepo(db, now)
    const roles = [testRole({ id: 'p', name: 'Planner' }), testRole({ id: 'i', name: 'Implementer', model: 'opus' })]
    const runId = await repo.create(ticketId, roles)
    const run = (await repo.latest(ticketId))!
    expect(run).toMatchObject({ id: runId, roleId: 'p', role: 'Planner' })
    expect(await repo.ticketRun(run.ticketRunId)).toEqual({
      id: run.ticketRunId,
      ticketId,
      roles,
      extraInstructions: null,
      status: 'running',
      startedAt: FIXED_NOW.toISOString(),
      endedAt: null
    })
    await expect(repo.create(ticketId, [])).rejects.toThrow(/at least one role/)
  })

  it('create stores the extra instructions on the ticket run', async () => {
    const repo = createRunRepo(db, now)
    await repo.create(ticketId, [testRole()], 'Keep the diff small.')
    const run = (await repo.latest(ticketId))!
    expect((await repo.ticketRun(run.ticketRunId)).extraInstructions).toBe('Keep the diff small.')
  })

  it("handOn starts the next role's run before ending the previous one as handed off", async () => {
    const repo = createRunRepo(db, now)
    const next = testRole({ id: 'r', name: 'Reviewer', model: 'sonnet', effort: 'low' })
    const first = await repo.create(ticketId, [testRole(), next])
    const second = await repo.handOn(first, next)

    expect(second).toMatchObject({ role: 'Reviewer', sessionId: null, returnToRoleId: null, endReason: null })
    const runs = await repo.listForTicket(ticketId)
    expect(runs.map((r) => [r.id, r.role, r.endReason])).toEqual([
      [first, 'Implementer', 'handoff'],
      [second!.id, 'Reviewer', null]
    ])
    expect(runs[1]).toEqual(second)
    expect(runs[1]).toMatchObject({ ticketRunId: runs[0]!.ticketRunId, roleId: 'r' })
    expect(await repo.listForTicketRun(runs[0]!.ticketRunId)).toEqual(runs)
    expect((await repo.latest(ticketId))?.id).toBe(second!.id)
    expect((await repo.ticketRun(runs[0]!.ticketRunId)).status).toBe('running')
  })

  it('handOn changes nothing once the previous run or its ticket run has ended', async () => {
    const repo = createRunRepo(db, now)
    const next = testRole({ id: 'r', name: 'Reviewer' })
    const stopped = await repo.create(ticketId, [testRole(), next])
    await repo.end(stopped, 'stopped')
    expect(await repo.handOn(stopped, next)).toBeNull()
    expect(await repo.handBack(stopped, next, 'i')).toBeNull()
    expect(await repo.listForTicket(ticketId)).toHaveLength(1)
    expect(await repo.handOn('missing', next)).toBeNull()
    expect(await repo.handBack('missing', next, 'i')).toBeNull()
  })

  it("handBack starts the earlier role's run on its last session, returning to the reporter, and ends the reporter as handed back", async () => {
    const repo = createRunRepo(db, now)
    const implementer = testRole({ id: 'i', name: 'Implementer' })
    const reviewer = testRole({ id: 'r', name: 'Reviewer' })
    const first = await repo.create(ticketId, [implementer, reviewer])
    await repo.setSession(first, 'sess-i')
    const review = (await repo.handOn(first, reviewer))!
    await repo.setSession(review.id, 'sess-r')

    const back = await repo.handBack(review.id, implementer, 'r')
    expect(back).toMatchObject({ roleId: 'i', sessionId: 'sess-i', returnToRoleId: 'r', endReason: null })
    expect((await repo.latest(ticketId))?.id).toBe(back!.id)
    const runs = await repo.listForTicketRun(review.ticketRunId)
    expect(runs.map((r) => [r.role, r.endReason])).toEqual([
      ['Implementer', 'handoff'],
      ['Reviewer', 'handed_back'],
      ['Implementer', null]
    ])
    // A hand-back never ends the ticket run.
    expect((await repo.ticketRun(review.ticketRunId)).status).toBe('running')

    // The Implementer's handoff returns to the Reviewer's session, with no return role of its own.
    const again = await repo.handOn(back!.id, reviewer)
    expect(again).toMatchObject({ roleId: 'r', sessionId: 'sess-r', returnToRoleId: null })
  })

  it('handOn carries on the return role of the role it hands to, so a chain of hand-backs unwinds in order', async () => {
    const repo = createRunRepo(db, now)
    const [planner, implementer, reviewer] = [
      testRole({ id: 'p', name: 'Planner' }),
      testRole({ id: 'i', name: 'Implementer' }),
      testRole({ id: 'r', name: 'Reviewer' })
    ]
    const plan = await repo.create(ticketId, [planner, implementer, reviewer])
    const impl = (await repo.handOn(plan, implementer))!
    const review = (await repo.handOn(impl.id, reviewer))!
    // Reviewer → Implementer, then Implementer → Planner.
    const impl2 = (await repo.handBack(review.id, implementer, 'r'))!
    const plan2 = (await repo.handBack(impl2.id, planner, 'i'))!
    expect(plan2.returnToRoleId).toBe('i')
    // The Planner hands off to the Implementer, which still owes the Reviewer.
    const impl3 = (await repo.handOn(plan2.id, implementer))!
    expect(impl3.returnToRoleId).toBe('r')
  })

  it('handBack changes nothing once the reporter has been handed back already', async () => {
    const repo = createRunRepo(db, now)
    const implementer = testRole({ id: 'i', name: 'Implementer' })
    const reviewer = testRole({ id: 'r', name: 'Reviewer' })
    const first = await repo.create(ticketId, [implementer, reviewer])
    const review = (await repo.handOn(first, reviewer))!
    expect(await repo.handBack(review.id, implementer, 'r')).not.toBeNull()
    expect(await repo.handBack(review.id, implementer, 'r')).toBeNull()
    expect(await repo.listForTicketRun(review.ticketRunId)).toHaveLength(3)
  })

  it('ending a run ends its ticket run: a handoff as done, a stop or failure as such', async () => {
    const repo = createRunRepo(db, now)
    for (const [reason, status] of [
      ['handoff', 'done'],
      ['stopped', 'stopped'],
      ['failed', 'failed']
    ] as const) {
      const runId = await repo.create(ticketId, [testRole()])
      clock = new Date('2026-10-30T12:30:00.000Z')
      await repo.end(runId, reason)
      const run = (await repo.latest(ticketId))!
      expect(await repo.ticketRun(run.ticketRunId)).toMatchObject({ status, endedAt: '2026-10-30T12:30:00.000Z' })
      clock = FIXED_NOW
    }
  })

  it('latest is the most recently started run', async () => {
    const repo = createRunRepo(db, now)
    const first = await repo.create(ticketId, [testRole()])
    clock = new Date('2026-10-30T13:00:00.000Z')
    const second = await repo.create(ticketId, [testRole()])
    expect(first).not.toBe(second)
    expect((await repo.latest(ticketId))?.id).toBe(second)
  })

  it('latest breaks a same-instant tie by creation order', async () => {
    const repo = createRunRepo(db, now)
    await repo.create(ticketId, [testRole()])
    const second = await repo.create(ticketId, [testRole()])
    expect((await repo.latest(ticketId))?.id).toBe(second)
  })

  it('listForTicket lists every run of the ticket, oldest first', async () => {
    const repo = createRunRepo(db, now)
    expect(await repo.listForTicket(ticketId)).toEqual([])
    clock = new Date('2026-10-30T13:00:00.000Z')
    const second = await repo.create(ticketId, [testRole()])
    clock = FIXED_NOW
    const first = await repo.create(ticketId, [testRole()])
    // Same instant as `first`: creation order breaks the tie.
    const firstTie = await repo.create(ticketId, [testRole()])
    await repo.end(first, 'handoff')

    const runs = await repo.listForTicket(ticketId)
    expect(runs.map((r) => r.id)).toEqual([first, firstTie, second])
    expect(runs[0]).toMatchObject({ ticketId, role: 'Implementer', endReason: 'handoff' })
  })

  it('records the session and how the run ended', async () => {
    const repo = createRunRepo(db, now)
    const runId = await repo.create(ticketId, [testRole()])
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
    const runId = await repo.create(ticketId, [testRole()])

    expect(await repo.end(runId, 'stopped')).toBe(true)
    clock = new Date('2026-10-30T12:45:00.000Z')
    expect(await repo.end(runId, 'handoff')).toBe(false)

    expect(await repo.latest(ticketId)).toMatchObject({ endReason: 'stopped', endedAt: '2026-10-30T12:00:00.000Z' })
  })

  it('events get consecutive seq numbers per run', async () => {
    const repo = createRunRepo(db, now)
    const a = await repo.create(ticketId, [testRole()])
    const b = await repo.create(ticketId, [testRole()])

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
    const runId = await repo.create(ticketId, [testRole()])
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
