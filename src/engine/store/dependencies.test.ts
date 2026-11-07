import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Db } from '../db/open'
import { replaceDependencyStatements } from './dependencies'
import { createRepos, type Repos } from './index'
import { FIXED_NOW, openTestDb } from './testDb'

let db: Db
let cleanup: () => void
let repos: Repos
let ws: { id: string }
let ids: string[]

const AT = FIXED_NOW.toISOString()

const link = async (ticketId: string, blockerIds: string[], at = AT) => {
  const [first, ...rest] = replaceDependencyStatements(db, ticketId, blockerIds, at)
  await db.batch([first!, ...rest])
}

beforeEach(async () => {
  ;({ db, cleanup } = await openTestDb())
  repos = createRepos(db, () => FIXED_NOW)
  ws = await repos.workspaces.create('C:\\code\\shop', 'main', 'shop', 'shop')
  ids = []
  for (const title of ['One', 'Two', 'Three']) {
    ids.push((await repos.tickets.create({ workspaceId: ws.id, title, intent: 'x', spec: '', criteria: [], labels: [], column: 'backlog' })).id)
  }
})

afterEach(() => cleanup())

describe('dependency repo', () => {
  test('adds, replaces and removes links, listing blockers in number order', async () => {
    await link(ids[2]!, [ids[1]!, ids[0]!])
    expect((await repos.dependencies.blockersOf(ids[2]!)).map((b) => [b.number, b.title, b.done])).toEqual([
      [1, 'One', false],
      [2, 'Two', false]
    ])
    await link(ids[2]!, [ids[0]!])
    expect((await repos.dependencies.blockersOf(ids[2]!)).map((b) => b.number)).toEqual([1])
    await link(ids[2]!, [])
    expect(await repos.dependencies.blockersOf(ids[2]!)).toEqual([])
  })

  test('replacing the links bumps the ticket, so an orchestrator edit cannot be undone over it', async () => {
    const later = new Date(FIXED_NOW.getTime() + 60_000).toISOString()
    await link(ids[1]!, [ids[0]!], later)
    expect((await repos.tickets.get(ids[1]!)).updatedAt).toBe(later)
  })

  test('a dependency is satisfied when its blocker is Done', async () => {
    await link(ids[1]!, [ids[0]!])
    expect([...(await repos.dependencies.blockedIds(ws.id))]).toEqual([ids[1]])
    await repos.tickets.setManualColumn(ids[0]!, 'done')
    expect((await repos.dependencies.blockersOf(ids[1]!))[0]!.done).toBe(true)
    expect((await repos.dependencies.blockedIds(ws.id)).size).toBe(0)
    // Moved back out of Done, it blocks again.
    await repos.tickets.setManualColumn(ids[0]!, 'ready')
    expect((await repos.dependencies.blockedIds(ws.id)).size).toBe(1)
  })

  test('a blocker in a removed workspace no longer blocks', async () => {
    await link(ids[1]!, [ids[0]!])
    await db.run(sql`update workspaces set removed_at = ${AT} where id = ${ws.id}`)
    expect(await repos.dependencies.blockersOf(ids[1]!)).toEqual([])
    expect((await repos.dependencies.blockedIds(ws.id)).size).toBe(0)
  })

  test('the links can be found from the blocker, and make the cycle check graph', async () => {
    await link(ids[1]!, [ids[0]!])
    await link(ids[2]!, [ids[0]!, ids[1]!])
    expect((await repos.dependencies.dependentsOf(ids[0]!)).sort()).toEqual([ids[1], ids[2]].sort())
    expect((await repos.dependencies.edges(ws.id)).get(ids[2]!)?.sort()).toEqual([ids[0], ids[1]].sort())
  })

  test('notes are kept in order per ticket, and unblocked ones can be read since a time', async () => {
    await repos.dependencies.addNote(ids[1]!, { kind: 'started_blocked', blockers: [{ number: 1, title: 'One' }], via: 'ticket' })
    await repos.dependencies.addNote(ids[1]!, { kind: 'unblocked', blockers: [{ number: 1, title: 'One' }], via: null })
    expect((await repos.dependencies.notesFor(ids[1]!)).map((n) => [n.kind, n.via])).toEqual([
      ['started_blocked', 'ticket'],
      ['unblocked', null]
    ])
    expect((await repos.dependencies.notesForWorkspace(ws.id)).get(ids[1]!)).toHaveLength(2)
    const unblocked = await repos.dependencies.unblockedSince(null)
    expect(unblocked).toHaveLength(1)
    expect(unblocked[0]).toMatchObject({ ticketId: ids[1], blockers: [{ number: 1, title: 'One' }] })
    expect(await repos.dependencies.unblockedSince(new Date(FIXED_NOW.getTime() + 1000).toISOString())).toEqual([])
  })
})
