import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NewTicketInput } from '../../shared/domain'
import type { Db } from '../db/open'
import { FIXED_NOW, openTestDb } from './testDb'
import { createTicketRepo } from './tickets'
import { createWorkspaceRepo } from './workspaces'

let db: Db
let cleanup: () => void
let workspaceId: string
let clock: Date
const now = () => clock

beforeEach(async () => {
  ;({ db, cleanup } = await openTestDb())
  clock = FIXED_NOW
  workspaceId = (await createWorkspaceRepo(db, now).create('/r', 'main', 'r', 'r')).id
})
afterEach(() => cleanup())

function input(overrides: Partial<NewTicketInput> = {}): NewTicketInput {
  return {
    workspaceId,
    title: 'Add login',
    intent: 'Let people log in',
    spec: 'Use a form',
    criteria: ['form renders', 'bad password rejected'],
    labels: ['auth'],
    column: 'backlog',
    ...overrides
  }
}

describe('ticket repo', () => {
  it('ticket numbers increase per workspace starting at 1', async () => {
    const repo = createTicketRepo(db, now)
    const other = await createWorkspaceRepo(db, now).create('/other', 'main', 'other', 'other')

    const a = await repo.create(input())
    const b = await repo.create(input({ title: 'Second' }))
    const c = await repo.create(input({ workspaceId: other.id }))

    expect([a.number, b.number, c.number]).toEqual([1, 2, 1])
  })

  it('creates a ticket with its criteria unchecked and in order', async () => {
    const repo = createTicketRepo(db, now)
    const t = await repo.create(input({ column: 'ready' }))
    expect(t).toEqual({
      id: expect.any(String),
      workspaceId,
      number: 1,
      kind: 'change',
      title: 'Add login',
      intent: [{ text: 'Let people log in', at: FIXED_NOW.toISOString() }],
      spec: 'Use a form',
      criteria: [
        { position: 0, text: 'form renders', checked: false },
        { position: 1, text: 'bad password rejected', checked: false }
      ],
      labels: ['auth'],
      manualColumn: 'ready',
      branch: null,
      worktreePath: null,
      createdAt: FIXED_NOW.toISOString(),
      updatedAt: FIXED_NOW.toISOString()
    })
    expect(await repo.get(t.id)).toEqual(t)
  })

  it('intent is stored verbatim and only appended', async () => {
    const repo = createTicketRepo(db, now)
    const t = await repo.create(input({ intent: 'Fix it  \n exactly' }))
    const after = await repo.appendIntent(t.id, 'also X')
    expect(after.intent.map((e) => e.text)).toEqual(['Fix it  \n exactly', 'also X'])
    expect((await repo.get(t.id)).intent.map((e) => e.text)).toEqual(['Fix it  \n exactly', 'also X'])

    // TicketPatch has no intent key, so intent cannot be rewritten through update.
    // @ts-expect-error intent is not part of TicketPatch
    await repo.update(t.id, { intent: 'x' })
    expect((await repo.get(t.id)).intent.map((e) => e.text)).toEqual(['Fix it  \n exactly', 'also X'])
  })

  it('concurrent appendIntent calls both land', async () => {
    const repo = createTicketRepo(db, now)
    const t = await repo.create(input())
    await Promise.all([repo.appendIntent(t.id, 'one'), repo.appendIntent(t.id, 'two')])
    const texts = (await repo.get(t.id)).intent.map((e) => e.text)
    expect(texts[0]).toBe('Let people log in')
    expect(texts.slice(1).sort()).toEqual(['one', 'two'])
  })

  it('appendIntent stamps the time and bumps updatedAt', async () => {
    const repo = createTicketRepo(db, now)
    const t = await repo.create(input())
    clock = new Date('2026-10-31T08:00:00.000Z')
    const after = await repo.appendIntent(t.id, 'later')
    expect(after.intent[1]).toEqual({ text: 'later', at: '2026-10-31T08:00:00.000Z' })
    expect(after.updatedAt).toBe('2026-10-31T08:00:00.000Z')
  })

  it('updates title, spec and labels', async () => {
    const repo = createTicketRepo(db, now)
    const t = await repo.create(input())
    clock = new Date('2026-10-31T08:00:00.000Z')
    const after = await repo.update(t.id, { title: 'New title', spec: 'New spec', labels: ['a', 'b'] })
    expect(after).toMatchObject({ title: 'New title', spec: 'New spec', labels: ['a', 'b'] })
    expect(after.updatedAt).toBe('2026-10-31T08:00:00.000Z')
    expect(after.criteria).toEqual(t.criteria)
  })

  it('update with criteria replaces them, keeping the checked state it is given', async () => {
    const repo = createTicketRepo(db, now)
    const t = await repo.create(input())
    const after = await repo.update(t.id, {
      criteria: [{ position: 0, text: 'only one', checked: true }]
    })
    expect(after.criteria).toEqual([{ position: 0, text: 'only one', checked: true }])
    expect((await repo.get(t.id)).criteria).toEqual(after.criteria)
  })

  it('lists a workspace tickets by number and keeps criteria on each', async () => {
    const repo = createTicketRepo(db, now)
    const other = await createWorkspaceRepo(db, now).create('/other', 'main', 'other', 'other')
    await repo.create(input({ title: 'One' }))
    await repo.create(input({ title: 'Two', criteria: [] }))
    await repo.create(input({ workspaceId: other.id, title: 'Elsewhere' }))

    const list = await repo.list(workspaceId)
    expect(list.map((t) => [t.number, t.title, t.criteria.length])).toEqual([
      [1, 'One', 2],
      [2, 'Two', 0]
    ])
  })

  it('sets the manual column', async () => {
    const repo = createTicketRepo(db, now)
    const t = await repo.create(input())
    expect((await repo.setManualColumn(t.id, 'done')).manualColumn).toBe('done')
    expect((await repo.get(t.id)).manualColumn).toBe('done')
  })

  it('sets and clears the worktree', async () => {
    const repo = createTicketRepo(db, now)
    const t = await repo.create(input())
    const set = await repo.setWorktree(t.id, 'mainbus/1-add-login', 'C:\\home\\work\\r\\1-add-login')
    expect(set).toMatchObject({ branch: 'mainbus/1-add-login', worktreePath: 'C:\\home\\work\\r\\1-add-login' })
    const cleared = await repo.setWorktree(t.id, 'mainbus/1-add-login', null)
    expect(cleared).toMatchObject({ branch: 'mainbus/1-add-login', worktreePath: null })
  })

  it('throws for an unknown ticket', async () => {
    const repo = createTicketRepo(db, now)
    await expect(repo.get('missing')).rejects.toThrow(/ticket/i)
    await expect(repo.update('missing', { title: 'x' })).rejects.toThrow(/ticket/i)
    await expect(repo.appendIntent('missing', 'x')).rejects.toThrow(/ticket/i)
  })
})
