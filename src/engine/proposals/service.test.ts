import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { EngineEvent } from '../../shared/api'
import type { Workspace } from '../../shared/domain'
import type { Proposal } from '../../shared/proposals'
import { createRepos, type Repos } from '../store'
import { FIXED_NOW, openTestDb } from '../store/testDb'
import type { ExecContext } from './kind'
import { createProposalService, OUTCOME_HEADING, type ProposalService } from './service'

const MESSAGE = 'Please add login and logout tickets.'

let cleanup: () => void
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
  clock = FIXED_NOW
  repos = createRepos(testDb.db, () => clock)
  ws = await repos.workspaces.create('/repo', 'main', 'repo', 'repo')
  runId = (await repos.orchestrator.create()).id
  events = []
  exec = {
    workspace: () => repos.workspaces.get(),
    createTickets: (w, inputs) => repos.tickets.createMany(inputs.map((i) => ({ ...i, workspaceId: w.id })))
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
