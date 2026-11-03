import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { EngineEvent } from '../../shared/api'
import type { Hold, Workspace } from '../../shared/domain'
import type { Proposal } from '../../shared/proposals'
import { KINDS } from './registry'
import type { Db } from '../db/open'
import { createRepos, type Repos } from '../store'
import { FIXED_NOW, openTestDb } from '../store/testDb'
import type { ExecContext } from './kind'
import { createProposalService, OUTCOME_HEADING, QUIT_ATOMIC_ERROR, QUIT_PARTIAL_ERROR, type ProposalService } from './service'

const MESSAGE = 'Please add login and logout tickets.'

let cleanup: () => void
let db: Db
let repos: Repos
let ws: Workspace
let runId: string
let events: EngineEvent[]
let exec: ExecContext
let service: ProposalService
let clock: Date

const at = (minutes: number) => new Date(FIXED_NOW.getTime() + minutes * 60_000)

beforeEach(async () => {
  const testDb = await openTestDb()
  cleanup = testDb.cleanup
  db = testDb.db
  clock = FIXED_NOW
  repos = createRepos(testDb.db, () => clock)
  ws = await repos.workspaces.create('/repo', 'main', 'repo', 'repo')
  runId = (await repos.orchestrator.create()).id
  events = []
  exec = {
    workspace: () => repos.workspaces.focused(),
    // Like the engine's: the result is recorded in the same batch as the tickets.
    createTickets: (w, inputs, record) =>
      repos.tickets.createMany(
        inputs.map((i) => ({ ...i, workspaceId: w.id })),
        record && ((ids) => [repos.proposals.ticketsResultStatement(record.proposalId, ids, record.column)])
      ),
    lineup: (workspaceId) => repos.lineups.get(workspaceId),
    ticketByNumber: (workspaceId, n) => repos.tickets.byNumber(workspaceId, n),
    whyNotStartable: async () => null,
    startTicket: async () => {},
    activeRole: async () => null,
    pauseTicket: async () => {},
    stopTicket: async () => {},
    skipTicket: async () => {},
    now: () => clock,
    holdTicket: async () => ({}) as Hold,
    decision: async () => null,
    openStuckEpisode: async () => null,
    redirectTicket: async () => {},
    replaceTicket: async () => {},
    whyNotPromotable: async () => null,
    draftPromotionSpec: async () => ({ spec: '', drafted: false }),
    promoteTicket: async () => { throw new Error('not expected') },
    answerDecision: async () => {}
  }
  service = createProposalService({ repo: repos.proposals, emit: (e) => events.push(e), exec })
})

afterEach(() => cleanup())

const TWO = { tickets: [{ title: 'Login', spec: 'Use a form' }, { title: 'Logout' }] }

async function proposeTwo(input: unknown = TWO): Promise<Proposal> {
  const made = await service.propose('create_tickets', input, { workspaceId: ws.id, orchestratorRunId: runId, userMessage: MESSAGE })
  if (!made.ok) throw new Error(made.error)
  return made.proposal
}

const changes = () => events.flatMap((e) => (e.type === 'proposal.changed' ? [e.proposal.status] : []))

describe('proposal service', () => {
  test('propose stores a pending proposal with the evidence apart from the payload, and says so', async () => {
    const p = await proposeTwo({ ...TWO, evidence: 'README lists no auth' })
    expect(p).toMatchObject({
      kind: 'create_tickets',
      status: 'pending',
      evidence: 'README lists no auth',
      payload: { intent: MESSAGE, column: 'backlog', tickets: [{ title: 'Login' }, { title: 'Logout' }] }
    })
    expect(changes()).toEqual(['pending'])
    expect(await service.list()).toEqual([p])
  })

  test('an invalid payload stores nothing and says why', async () => {
    const at = { workspaceId: ws.id, orchestratorRunId: runId, userMessage: MESSAGE }
    expect(await service.propose('create_tickets', { tickets: [{ title: 'A', intent: 'x' }] }, at)).toEqual({
      ok: false,
      error: 'Unknown field: tickets.0.intent'
    })
    expect(await service.propose('create_tickets', { ...TWO, evidence: 3 }, at)).toEqual({ ok: false, error: 'evidence: must be text' })
    expect(await service.list()).toEqual([])
    expect(events).toEqual([])
  })

  test("a kind's own evidence field becomes the evidence: a start's reason", async () => {
    const t = await repos.tickets.create({ workspaceId: ws.id, title: 'Login', intent: 'x', spec: '', criteria: [], labels: [], column: 'backlog' })
    const at = { workspaceId: ws.id, orchestratorRunId: runId, userMessage: MESSAGE }
    const made = await service.propose('start_lineup', { ticket: t.number, reason: 'It is small and ready' }, at)
    expect(made).toMatchObject({ ok: true, proposal: { kind: 'start_lineup', evidence: 'It is small and ready' } })
    expect(made.ok && made.proposal.payload).toMatchObject({ ticketId: t.id, number: t.number })
    // Its evidence is the reason, so `evidence` is no field of it.
    expect(await service.propose('start_lineup', { ticket: t.number, evidence: 'x' }, at)).toEqual({
      ok: false,
      error: 'Unknown field: evidence'
    })
    expect(await service.propose('start_lineup', { ticket: t.number, reason: 3 }, at)).toEqual({ ok: false, error: 'reason: must be text' })
  })

  test('confirm creates the tickets and records them as the result', async () => {
    const p = await proposeTwo()
    const done = await service.confirm(p.id)
    const tickets = await repos.tickets.list(ws.id)
    expect(tickets.map((t) => [t.number, t.title, t.manualColumn, t.intent.map((e) => e.text)])).toEqual([
      [1, 'Login', 'backlog', [MESSAGE]],
      [2, 'Logout', 'backlog', [MESSAGE]]
    ])
    // The user's own words: no agent source.
    expect(tickets.every((t) => t.intent[0]!.source === undefined)).toBe(true)
    expect(done).toMatchObject({
      status: 'confirmed',
      result: { tickets: [{ id: tickets[0]!.id, number: 1, title: 'Login' }, { id: tickets[1]!.id, number: 2, title: 'Logout' }], column: 'backlog' }
    })
    expect(changes()).toEqual(['pending', 'confirmed', 'confirmed'])
    // Once only.
    await expect(service.confirm(p.id)).rejects.toThrow('is confirmed, not pending')
    await expect(service.reject(p.id)).rejects.toThrow('not pending')
    expect(await repos.tickets.list(ws.id)).toHaveLength(2)
  })

  test('confirm with an override creates the edited drafts it kept, in its column; the stored payload stays as proposed', async () => {
    const p = await proposeTwo()
    const done = await service.confirm(p.id, {
      tickets: [{ title: 'Sign out', spec: 'Edited', criteria: ['gone'], labels: [] }],
      column: 'ready'
    })
    const tickets = await repos.tickets.list(ws.id)
    expect(tickets.map((t) => [t.title, t.spec, t.manualColumn, t.intent[0]!.text])).toEqual([['Sign out', 'Edited', 'ready', MESSAGE]])
    expect(done).toMatchObject({ status: 'overridden', result: { tickets: [{ number: 1, title: 'Sign out' }], column: 'ready' } })
    expect((done.payload as { tickets: unknown[] }).tickets).toHaveLength(2)
  })

  test('an invalid override changes nothing: the proposal stays pending', async () => {
    const p = await proposeTwo()
    await expect(service.confirm(p.id, { tickets: [] })).rejects.toThrow('tickets: must have at least 1 ticket')
    await expect(service.confirm(p.id, { tickets: [{ title: 'A' }, { title: '' }] })).rejects.toThrow('tickets.1.title')
    expect((await repos.proposals.get(p.id)).status).toBe('pending')
    expect(await repos.tickets.list(ws.id)).toEqual([])
  })

  test('reject creates nothing', async () => {
    const p = await proposeTwo()
    expect(await service.reject(p.id)).toMatchObject({ status: 'rejected', result: null })
    expect(await repos.tickets.list(ws.id)).toEqual([])
    await expect(service.confirm(p.id)).rejects.toThrow('is rejected, not pending')
  })

  test('a failure while carrying it out makes it failed, with the error, and creates no tickets', async () => {
    const p = await proposeTwo()
    // The second insert fails, after the first went in: the transaction undoes it.
    exec.createTickets = (w, inputs) =>
      repos.tickets.createMany(inputs.map((i, n) => ({ ...i, workspaceId: n === 1 ? 'missing' : w.id })))
    const done = await service.confirm(p.id)
    expect(done.status).toBe('failed')
    // The database's own error, not the query and its parameters.
    expect((done.result as { error: string }).error).toMatch(/FOREIGN KEY/i)
    expect((done.result as { error: string }).error).not.toContain('insert into')
    expect(await repos.tickets.list(ws.id)).toEqual([])
    expect(changes()).toEqual(['pending', 'confirmed', 'failed'])
  })

  test('a failure is the proposal failed, not a thrown error', async () => {
    const p = await proposeTwo()
    exec.createTickets = vi.fn(async () => {
      throw new Error('disk full')
    })
    expect(await service.confirm(p.id)).toMatchObject({ status: 'failed', result: { error: 'disk full' } })
  })

  test('the result is recorded in the same transaction as the tickets: both exist, or neither', async () => {
    const p = await proposeTwo()
    const claimed = await repos.proposals.claim(p.id, 'confirmed')
    expect(claimed.result).toBeNull()
    const made = await exec.createTickets(ws, [{ title: 'A', intent: 'x', spec: '', criteria: [], labels: [], column: 'ready' }], {
      proposalId: p.id,
      column: 'ready'
    })
    // Recorded by the batch itself, before anything else writes it.
    expect((await repos.proposals.get(p.id)).result).toEqual({ tickets: [{ id: made[0]!.id, number: 1, title: 'A' }], column: 'ready' })
  })

  test('when the result write fails after the tickets went in, no ticket is left', async () => {
    const p = await proposeTwo()
    // The proposal's result can't be written: the tickets' inserts, earlier in the batch, are undone.
    await db.run(sql.raw(`create trigger no_result before update of result on proposals when new.status <> 'failed' begin select raise(abort, 'disk full'); end`))
    const done = await service.confirm(p.id)
    expect(done).toMatchObject({ status: 'failed', result: { error: expect.stringContaining('disk full') } })
    expect(await repos.tickets.list(ws.id)).toEqual([])
  })

  describe('failUnfinished (at startup)', () => {
    test('fails a claimed proposal with no result: nothing was created, for an atomic kind', async () => {
      const confirmed = await proposeTwo()
      const overridden = await proposeTwo()
      await repos.proposals.claim(confirmed.id, 'confirmed')
      await repos.proposals.claim(overridden.id, 'overridden')
      await service.failUnfinished()
      expect(await repos.proposals.get(confirmed.id)).toMatchObject({ status: 'failed', result: { error: QUIT_ATOMIC_ERROR } })
      expect(await repos.proposals.get(overridden.id)).toMatchObject({ status: 'failed', result: { error: QUIT_ATOMIC_ERROR } })
      expect(QUIT_ATOMIC_ERROR).toBe('Mainbus quit before carrying this out; nothing was created.')
    })

    test('leaves pending, rejected, failed and finished proposals alone', async () => {
      const pending = await proposeTwo()
      const rejected = await proposeTwo()
      const failed = await proposeTwo()
      const finished = await proposeTwo()
      await service.reject(rejected.id)
      await repos.proposals.claim(failed.id, 'confirmed')
      await repos.proposals.fail(failed.id, 'it broke')
      await service.confirm(finished.id)
      const before = await service.list()
      await service.failUnfinished()
      expect(await service.list()).toEqual(before)
      expect((await repos.proposals.get(pending.id)).status).toBe('pending')
    })

    test('a kind that is not atomic gets the may-have-partly-happened error', async () => {
      const kinds = { ...KINDS, create_tickets: { ...KINDS.create_tickets, atomicWithResult: false } }
      const loose = createProposalService({ repo: repos.proposals, emit: () => {}, exec, kinds })
      const p = await proposeTwo()
      await repos.proposals.claim(p.id, 'confirmed')
      await loose.failUnfinished()
      expect(await repos.proposals.get(p.id)).toMatchObject({ status: 'failed', result: { error: QUIT_PARTIAL_ERROR } })
      expect(QUIT_PARTIAL_ERROR).toBe('Mainbus quit while carrying this out; it may have partly happened. Check the board.')
    })

    test('the outcome block then reports it as failed, not as still being carried out', async () => {
      const p = await proposeTwo()
      await repos.proposals.claim(p.id, 'confirmed')
      expect(await service.outcomeBlock(null)).toContain('Mainbus is still carrying it out.')
      await service.failUnfinished()
      const block = await service.outcomeBlock(null)
      expect(block).toContain(`the user confirmed it, but it failed: ${QUIT_ATOMIC_ERROR}`)
      expect(block).not.toContain('still carrying')
    })
  })

  describe('outcomeBlock', () => {
    test('is null with nothing decided', async () => {
      await proposeTwo()
      expect(await service.outcomeBlock(null)).toBeNull()
    })

    test('lists each proposal decided since, and how it went', async () => {
      const confirmed = await proposeTwo()
      const overridden = await proposeTwo()
      const rejected = await proposeTwo()
      const failed = await proposeTwo()
      const old = await proposeTwo()
      await proposeTwo() // still pending: not listed

      await service.reject(old.id)
      clock = at(1)
      await service.confirm(confirmed.id)
      await service.confirm(overridden.id, { tickets: [{ title: 'Edited "title"', spec: '', criteria: [], labels: [] }], column: 'ready' })
      await service.reject(rejected.id)
      exec.createTickets = async () => {
        throw new Error('it broke\nbadly')
      }
      await service.confirm(failed.id)

      expect(await service.outcomeBlock(at(1).toISOString())).toBe(
        [
          OUTCOME_HEADING,
          `- Proposal ${confirmed.id} (create tickets): confirmed by the user. Created #1 "Login" and #2 "Logout" in Backlog.`,
          `- Proposal ${overridden.id} (create tickets): changed by the user, then confirmed. Created #3 "Edited \\"title\\"" in Ready.`,
          `- Proposal ${rejected.id} (create tickets): rejected by the user.`,
          `- Proposal ${failed.id} (create tickets): the user confirmed it, but it failed: it broke badly`
        ].join('\n')
      )
      expect((await service.outcomeBlock(null))?.split('\n')).toHaveLength(6)
    })
  })
})

describe('a proposal that is already pending', () => {
  const at = () => ({ workspaceId: ws.id, orchestratorRunId: runId, userMessage: MESSAGE })
  const newTicket = (title: string) =>
    repos.tickets.create({ workspaceId: ws.id, title, intent: 'x', spec: '', criteria: [], labels: [], column: 'backlog' })

  test('for the same ticket and kind is returned as it is, not stored twice', async () => {
    const t = await newTicket('Login')
    const first = await service.propose('start_lineup', { ticket: t.number, reason: 'It is small' }, at())
    const again = await service.propose('start_lineup', { ticket: t.number, reason: 'Still small' }, at())
    expect(first).toMatchObject({ ok: true, proposal: { status: 'pending' } })
    expect(again).toMatchObject({ ok: true, existing: true, proposal: { id: first.ok && first.proposal.id, evidence: 'It is small' } })
    expect(first).not.toHaveProperty('existing')
    expect(await service.list()).toHaveLength(1)
    expect(changes()).toEqual(['pending'])
  })

  test('is no obstacle for another ticket or another kind', async () => {
    const a = await newTicket('A')
    const b = await newTicket('B')
    await service.propose('start_lineup', { ticket: a.number, reason: 'r' }, at())
    expect(await service.propose('start_lineup', { ticket: b.number, reason: 'r' }, at())).not.toHaveProperty('existing')
    expect(await service.propose('hold', { ticket: a.number, reason: 'e' }, at())).not.toHaveProperty('existing')
    expect(await service.list()).toHaveLength(3)
  })

  test('a decided one no longer counts: the same proposal can be made again', async () => {
    const t = await newTicket('Login')
    const first = await service.propose('start_lineup', { ticket: t.number, reason: 'r' }, at())
    await service.reject(first.ok ? first.proposal.id : '')
    const again = await service.propose('start_lineup', { ticket: t.number, reason: 'r' }, at())
    expect(again).not.toHaveProperty('existing')
    expect(await service.list()).toHaveLength(2)
  })

  test('drafting tickets is never matched: every draft is its own proposal', async () => {
    await proposeTwo()
    await proposeTwo()
    expect(await service.list()).toHaveLength(2)
  })

  test('for an answer is matched by decision too: another decision of the same ticket gets its own proposal', async () => {
    const t = await newTicket('Login')
    const kinds = {
      ...KINDS,
      answer: { ...KINDS.answer, propose: async (input: unknown) => ({ ticketId: t.id, decisionId: (input as { decision: string }).decision }) }
    } as unknown as NonNullable<Parameters<typeof createProposalService>[0]['kinds']>
    const withKinds = createProposalService({ repo: repos.proposals, emit: () => {}, exec, kinds })
    const propose = (decision: string) =>
      withKinds.propose('answer', { decision, reasoning: 'r' }, at())
    const one = await propose('d1')
    expect(await propose('d1')).toMatchObject({ ok: true, existing: true, proposal: { id: one.ok && one.proposal.id } })
    expect(await propose('d2')).not.toHaveProperty('existing')
    expect(await withKinds.list()).toHaveLength(2)
  })
})
