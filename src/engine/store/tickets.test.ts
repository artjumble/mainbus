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

  it("appends the user's later messages after the intent, each with its own time, and marks only the first as the orchestrator's", async () => {
    const repo = createTicketRepo(db, now)
    const later = [
      { text: 'website', at: '2026-01-01T00:00:00.000Z' },
      { text: 'and logout', at: '2026-01-01T00:01:00.000Z' }
    ]
    const t = await repo.create(input({ intentAdded: later, via: 'orchestrator' }))
    expect(t.intent).toEqual([{ text: 'Let people log in', at: FIXED_NOW.toISOString(), via: 'orchestrator' }, ...later])
    expect((await repo.create(input())).intent).toEqual([{ text: 'Let people log in', at: FIXED_NOW.toISOString() }])
  })

  it("puts an agent's context last, with its source, after the user's words; the first entry keeps no source", async () => {
    const repo = createTicketRepo(db, now)
    const later = [{ text: 'website', at: '2026-01-01T00:00:00.000Z' }]
    const source = { kind: 'agent' as const, agent: 'orchestrator', cwd: '/h/orchestrator' }
    const t = await repo.create(input({ intentAdded: later, via: 'orchestrator', agentContext: { text: 'The user asked.', source } }))
    expect(t.intent).toEqual([
      { text: 'Let people log in', at: FIXED_NOW.toISOString(), via: 'orchestrator' },
      ...later,
      { text: 'The user asked.', at: FIXED_NOW.toISOString(), source }
    ])
    expect((await repo.get(t.id))!.intent).toEqual(t.intent)
  })

  it('keeps the kind (change unless asked) and saves a report', async () => {
    const repo = createTicketRepo(db, now)
    expect((await repo.create(input())).kind).toBe('change')
    const t = await repo.create(input({ kind: 'investigate' }))
    expect(t).toMatchObject({ kind: 'investigate', report: null })
    expect(await repo.setReport(t.id, '# Findings')).toMatchObject({ kind: 'investigate', report: '# Findings' })
    expect(await repo.get(t.id)).toMatchObject({ report: '# Findings' })
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
      pr: null,
      prError: null,
      report: null,
      promotedFrom: null,
      runSettings: null,
      createdAt: FIXED_NOW.toISOString(),
      updatedAt: FIXED_NOW.toISOString()
    })
    expect(await repo.get(t.id)).toEqual(t)
  })

  it('createMany creates the tickets in order, numbered on from the last', async () => {
    const repo = createTicketRepo(db, now)
    await repo.create(input({ title: 'Earlier' }))
    const made = await repo.createMany([input({ title: 'One', criteria: ['a'] }), input({ title: 'Two', criteria: [] })])
    expect(made.map((t) => [t.number, t.title, t.criteria.map((c) => c.text)])).toEqual([
      [2, 'One', ['a']],
      [3, 'Two', []]
    ])
    expect(await repo.get(made[1]!.id)).toEqual(made[1])
  })

  it('createMany at the same time as other creates: each gets its own numbers, and nothing fails', async () => {
    const repo = createTicketRepo(db, now)
    const made = await Promise.all([
      repo.createMany([input({ title: 'a1' }), input({ title: 'a2' })]),
      repo.create(input({ title: 'b' })),
      repo.createMany([input({ title: 'c1' }), input({ title: 'c2' })])
    ])
    const numbers = made.flat().map((t) => t.number)
    expect(numbers.toSorted((x, y) => x - y)).toEqual([1, 2, 3, 4, 5])
    // Each batch's tickets are numbered one after the other.
    expect(made[0]!.map((t) => t.number)).toEqual([made[0]![0]!.number, made[0]![0]!.number + 1])
    expect(made[2]!.map((t) => t.number)).toEqual([made[2]![0]!.number, made[2]![0]!.number + 1])
  })

  it('a batch inside an open transaction still works', async () => {
    const repo = createTicketRepo(db, now)
    await db.transaction(async () => {
      await repo.createMany([input({ title: 'inside' })])
    })
    expect((await repo.list(workspaceId)).map((t) => t.title)).toEqual(['inside'])
  })

  it('createMany creates none when one insert fails', async () => {
    const repo = createTicketRepo(db, now)
    // The second ticket's workspace doesn't exist: its insert breaks the foreign key, after the first went in.
    await expect(
      repo.createMany([input({ title: 'One' }), input({ title: 'Two', workspaceId: 'missing' }), input({ title: 'Three' })])
    ).rejects.toThrow()
    expect(await repo.list(workspaceId)).toEqual([])
    // Numbering is unaffected.
    expect((await repo.create(input())).number).toBe(1)
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

  it('records a pull request, and a failure until one succeeds', async () => {
    const repo = createTicketRepo(db, now)
    const t = await repo.create(input())
    expect(await repo.setPrError(t.id, 'gh is not signed in')).toMatchObject({ pr: null, prError: 'gh is not signed in' })
    const opened = await repo.setPr(t.id, { url: 'https://github.com/o/r/pull/7', number: 7 })
    expect(opened).toMatchObject({ pr: { url: 'https://github.com/o/r/pull/7', number: 7 }, prError: null })
    expect(await repo.setPrError(t.id, 'the push was rejected')).toMatchObject({
      pr: { url: 'https://github.com/o/r/pull/7', number: 7 },
      prError: 'the push was rejected'
    })
  })

  it('checkCriterion ticks the criterion at a position, never unticks, and is null out of range', async () => {
    const repo = createTicketRepo(db, now)
    const t = await repo.create(input())
    clock = new Date('2026-10-30T12:30:00.000Z')
    expect(await repo.checkCriterion(t.id, 1)).toEqual({ position: 1, text: 'bad password rejected', checked: true, wasChecked: false })
    const after = await repo.get(t.id)
    expect(after.criteria.map((c) => c.checked)).toEqual([false, true])
    expect(after.updatedAt).toBe('2026-10-30T12:30:00.000Z')
    // Ticking it again changes nothing and says it was already ticked.
    expect(await repo.checkCriterion(t.id, 1)).toEqual({ position: 1, text: 'bad password rejected', checked: true, wasChecked: true })
    expect((await repo.get(t.id)).criteria.map((c) => c.checked)).toEqual([false, true])
    expect(await repo.checkCriterion(t.id, 2)).toBeNull()
    expect(await repo.checkCriterion(t.id, -1)).toBeNull()
    expect(await repo.checkCriterion('missing', 0)).toBeNull()
  })

  it('createPromoted copies the intent exactly, the report and labels, into a Ready Change ticket linked to the original', async () => {
    const repo = createTicketRepo(db, now)
    const original = await repo.create(input({ kind: 'investigate', column: 'ready', source: { agent: 'Claude Code' } as never, criteria: ['c'], labels: ['perf'] }))
    clock = new Date('2026-11-01T00:00:00.000Z')
    await repo.appendIntent(original.id, 'Later words')
    await repo.setReport(original.id, '# Findings')
    const source = await repo.get(original.id)

    clock = new Date('2026-11-02T00:00:00.000Z')
    const promoted = await repo.createPromoted(source, { title: 'Fix it', spec: 'Do X' })
    expect(promoted).toMatchObject({
      kind: 'change',
      title: 'Fix it',
      spec: 'Do X',
      manualColumn: 'ready',
      report: '# Findings',
      promotedFrom: original.id,
      labels: ['perf'],
      criteria: [],
      number: source.number + 1,
      createdAt: '2026-11-02T00:00:00.000Z'
    })
    expect(promoted.intent).toEqual(source.intent)
    expect(promoted.intent).toHaveLength(2)
    expect(promoted.intent[1]!.at).toBe('2026-11-01T00:00:00.000Z')
    expect(source.promotedFrom).toBeNull()

    expect(await repo.promotedTo(original.id)).toEqual(promoted)
    expect(await repo.promotedTo(promoted.id)).toBeNull()
    expect((await repo.get(promoted.id)).promotedFrom).toBe(original.id)
  })

  it('stores run settings, reads them back, and clears them', async () => {
    const repo = createTicketRepo(db, now)
    const t = await repo.create(input())
    expect(t.runSettings).toBeNull()
    const settings = {
      excludedRoleIds: ['p'],
      roles: { i: { model: 'opus', effort: 'high' as const } },
      extraInstructions: 'Keep it small.',
      roleNames: { p: 'Planner', i: 'Implementer' }
    }
    expect((await repo.setRunSettings(t.id, settings)).runSettings).toEqual(settings)
    expect((await repo.get(t.id)).runSettings).toEqual(settings)
    expect((await repo.list(workspaceId))[0]!.runSettings).toEqual(settings)
    expect((await repo.setRunSettings(t.id, null)).runSettings).toBeNull()
    await expect(repo.setRunSettings('missing', null)).rejects.toThrow(/ticket/i)
  })

  it("createPromoted doesn't copy the run settings: the lineup differs", async () => {
    const repo = createTicketRepo(db, now)
    const original = await repo.create(input({ kind: 'investigate' }))
    const saved = await repo.setRunSettings(original.id, { excludedRoleIds: [], roles: {}, extraInstructions: 'x', roleNames: {} })
    const promoted = await repo.createPromoted(saved, { title: 'Fix it', spec: 'Do X' })
    expect(promoted.runSettings).toBeNull()
  })

  it('throws for an unknown ticket', async () => {
    const repo = createTicketRepo(db, now)
    await expect(repo.get('missing')).rejects.toThrow(/ticket/i)
    await expect(repo.update('missing', { title: 'x' })).rejects.toThrow(/ticket/i)
    await expect(repo.appendIntent('missing', 'x')).rejects.toThrow(/ticket/i)
  })
})
