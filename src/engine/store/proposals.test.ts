import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Db } from '../db/open'
import { createOrchestratorRepo } from './orchestrator'
import { createProposalRepo, type NewProposal, type ProposalRepo } from './proposals'
import { FIXED_NOW, openTestDb } from './testDb'
import { createWorkspaceRepo } from './workspaces'

let db: Db
let cleanup: () => void
let repo: ProposalRepo
let clock: Date
let base: Omit<NewProposal, 'payload'>

const at = (minutes: number) => new Date(FIXED_NOW.getTime() + minutes * 60_000)

beforeEach(async () => {
  ;({ db, cleanup } = await openTestDb())
  clock = FIXED_NOW
  const now = () => clock
  const workspaceId = (await createWorkspaceRepo(db, now).create('/r', 'main', 'r', 'r')).id
  const orchestratorRunId = (await createOrchestratorRepo(db, now).create()).id
  repo = createProposalRepo(db, now)
  base = { workspaceId, orchestratorRunId, kind: 'create_tickets', evidence: null }
})

afterEach(() => cleanup())

describe('proposal repo', () => {
  test('stores a pending proposal with its payload and evidence', async () => {
    const p = await repo.create({ ...base, payload: { tickets: [{ title: 'A' }] }, evidence: 'README says so' })
    expect(p).toEqual({
      id: p.id,
      ...base,
      payload: { tickets: [{ title: 'A' }] },
      evidence: 'README says so',
      status: 'pending',
      result: null,
      createdAt: FIXED_NOW.toISOString(),
      decidedAt: null
    })
    expect(await repo.get(p.id)).toEqual(p)
    await expect(repo.get('nope')).rejects.toThrow('Proposal not found: nope')
  })

  test('lists every proposal oldest first', async () => {
    const a = await repo.create({ ...base, payload: 1 })
    const b = await repo.create({ ...base, payload: 2 })
    expect((await repo.list()).map((p) => p.id)).toEqual([a.id, b.id])
  })

  test.each(['confirmed', 'overridden'] as const)('claims a pending proposal as %s, once only', async (status) => {
    const p = await repo.create({ ...base, payload: {} })
    clock = at(1)
    expect(await repo.claim(p.id, status)).toMatchObject({ status, decidedAt: at(1).toISOString(), result: null })
    await expect(repo.claim(p.id, 'confirmed')).rejects.toThrow(`Proposal ${p.id} is ${status}, not pending`)
    await expect(repo.reject(p.id)).rejects.toThrow('not pending')
  })

  test('rejects a pending proposal, once only', async () => {
    const p = await repo.create({ ...base, payload: {} })
    expect(await repo.reject(p.id)).toMatchObject({ status: 'rejected', decidedAt: FIXED_NOW.toISOString() })
    await expect(repo.reject(p.id)).rejects.toThrow(`Proposal ${p.id} is rejected, not pending`)
    await expect(repo.claim(p.id, 'confirmed')).rejects.toThrow('not pending')
  })

  test('two decisions at once: exactly one wins', async () => {
    const p = await repo.create({ ...base, payload: {} })
    const results = await Promise.allSettled([
      repo.claim(p.id, 'confirmed'),
      repo.claim(p.id, 'overridden'),
      repo.reject(p.id)
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2)
  })

  test('finish records the result; fail makes it failed with the error', async () => {
    const a = await repo.create({ ...base, payload: {} })
    await repo.claim(a.id, 'confirmed')
    expect(await repo.finish(a.id, { tickets: [1] })).toMatchObject({ status: 'confirmed', result: { tickets: [1] } })

    const b = await repo.create({ ...base, payload: {} })
    await repo.claim(b.id, 'overridden')
    expect(await repo.fail(b.id, 'disk full')).toMatchObject({ status: 'failed', result: { error: 'disk full' } })
  })

  test('decidedSince lists the proposals decided at or after a time, oldest decision first', async () => {
    const a = await repo.create({ ...base, payload: 'a' })
    const b = await repo.create({ ...base, payload: 'b' })
    const c = await repo.create({ ...base, payload: 'c' })
    await repo.create({ ...base, payload: 'pending' })
    clock = at(3)
    await repo.reject(b.id)
    clock = at(1)
    await repo.claim(c.id, 'confirmed')
    clock = at(5)
    await repo.claim(a.id, 'overridden')
    await repo.fail(a.id, 'boom')

    expect((await repo.decidedSince(null)).map((p) => p.payload)).toEqual(['c', 'b', 'a'])
    expect((await repo.decidedSince(at(3).toISOString())).map((p) => p.payload)).toEqual(['b', 'a'])
    expect(await repo.decidedSince(at(6).toISOString())).toEqual([])
  })
})
