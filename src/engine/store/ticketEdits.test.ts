import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Db } from '../db/open'
import { createOrchestratorRepo } from './orchestrator'
import { FIXED_NOW, openTestDb } from './testDb'
import { createTicketEditRepo, EditChangedError, type NewTicketEdit, type TicketEditRepo } from './ticketEdits'
import { createTicketRepo, type TicketRepo } from './tickets'
import { createWorkspaceRepo } from './workspaces'

let db: Db
let cleanup: () => void
let clock: Date
let tickets: TicketRepo
let edits: TicketEditRepo
let workspaceId: string
let orchestratorRunId: string
let ticketId: string

const later = (minutes: number) => new Date(FIXED_NOW.getTime() + minutes * 60_000)

beforeEach(async () => {
  ;({ db, cleanup } = await openTestDb())
  clock = FIXED_NOW
  const now = () => clock
  workspaceId = (await createWorkspaceRepo(db, now).create('/r', 'main', 'r', 'r')).id
  orchestratorRunId = (await createOrchestratorRepo(db, now).create()).id
  tickets = createTicketRepo(db, now)
  edits = createTicketEditRepo(db, now, tickets)
  const t = await tickets.create({
    workspaceId,
    title: 'Login',
    intent: 'Add login',
    spec: 'A form',
    criteria: ['renders', 'rejects'],
    labels: ['auth'],
    column: 'backlog'
  })
  ticketId = t.id
  await tickets.update(ticketId, { criteria: [{ position: 0, text: 'renders', checked: true }, { position: 1, text: 'rejects', checked: false }] })
  clock = later(1)
})
afterEach(() => cleanup())

async function edit(userWords: string[] = ['Drop the extras']): Promise<NewTicketEdit> {
  const t = await tickets.get(ticketId)
  return {
    ticketId,
    workspaceId,
    orchestratorRunId,
    patch: { title: 'Sign in', criteria: [{ position: 0, text: 'renders', checked: true }] },
    fields: ['title', 'criteria'],
    before: { title: t.title, criteria: t.criteria },
    after: { title: 'Sign in', criteria: [{ position: 0, text: 'renders', checked: true }] },
    userWords
  }
}

describe('ticket edit repo', () => {
  test('applies the fields and appends the words with one timestamp, and records exactly what was appended', async () => {
    const made = await edits.apply(await edit(['one', 'two']))
    const t = await tickets.get(ticketId)
    const at = later(1).toISOString()
    expect(t).toMatchObject({ title: 'Sign in', updatedAt: at, criteria: [{ position: 0, text: 'renders', checked: true }] })
    expect(t.intent).toEqual([
      { text: 'Add login', at: FIXED_NOW.toISOString() },
      { text: 'one', at },
      { text: 'two', at }
    ])
    expect(made).toMatchObject({ ticketId, number: 1, at, fields: ['title', 'criteria'], ticketUpdatedAt: at, undoneAt: null, intentAdded: t.intent.slice(1) })
    expect(await edits.get(made.id)).toEqual(made)
    expect(await edits.listAll()).toEqual([made])
    expect(await edits.listForWorkspace(workspaceId)).toEqual([made])
    expect(await edits.listForWorkspace('other')).toEqual([])
  })

  test('is all or nothing: a failed record leaves the ticket as it was', async () => {
    await expect(edits.apply({ ...(await edit()), orchestratorRunId: 'no-such-run' })).rejects.toThrow()
    const t = await tickets.get(ticketId)
    expect(t).toMatchObject({ title: 'Login' })
    expect(t.intent).toHaveLength(1)
    expect(t.criteria).toHaveLength(2)
    expect(await edits.listAll()).toEqual([])
  })

  test('undo puts the fields back, removes only the entries this edit appended, and marks the edit undone', async () => {
    await tickets.appendIntent(ticketId, 'an earlier addition')
    clock = later(2)
    const before = await tickets.get(ticketId)
    const made = await edits.apply(await edit(['one']))
    clock = later(3)

    const undone = await edits.undo(made)
    const t = await tickets.get(ticketId)
    expect(t.title).toBe('Login')
    expect(t.criteria).toEqual(before.criteria)
    expect(t.intent).toEqual(before.intent)
    expect(t.updatedAt).toBe(later(3).toISOString())
    expect(undone.undoneAt).toBe(later(3).toISOString())
    await expect(edits.undo(undone)).rejects.toThrow('already undone')
  })

  test('undo with no words appended leaves the intent alone', async () => {
    const made = await edits.apply(await edit([]))
    await edits.undo(made)
    expect((await tickets.get(ticketId)).intent).toHaveLength(1)
  })

  test('undo is refused, changing nothing, when the ticket was updated or its words changed since', async () => {
    const made = await edits.apply(await edit(['one']))
    clock = later(2)
    await tickets.update(ticketId, { spec: 'Changed' })
    await expect(edits.undo(made)).rejects.toBeInstanceOf(EditChangedError)
    expect(await tickets.get(ticketId)).toMatchObject({ title: 'Sign in', spec: 'Changed' })
    expect((await edits.get(made.id)).undoneAt).toBeNull()

    const second = await edits.apply({ ...(await edit(['two'])), patch: { spec: 'Third' }, fields: ['spec'], before: { spec: 'Changed' }, after: { spec: 'Third' } })
    clock = later(3)
    await tickets.appendIntent(ticketId, 'after')
    await expect(edits.undo(second)).rejects.toThrow('#1 has changed since this edit, so it can\'t be undone')
    expect((await tickets.get(ticketId)).intent.map((e) => e.text)).toEqual(['Add login', 'one', 'two', 'after'])
  })
})
