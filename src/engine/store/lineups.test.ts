import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LineupRole, LineupRoleInput } from '../../shared/domain'
import type { Db } from '../db/open'
import { createLineupRepo, defaultInvestigateLineup, defaultLineup, lineupProblem, type LineupRepo } from './lineups'
import { FIXED_NOW, openTestDb } from './testDb'
import { createWorkspaceRepo } from './workspaces'

let db: Db
let cleanup: () => void
let workspaceId: string
let repo: LineupRepo

beforeEach(async () => {
  ;({ db, cleanup } = await openTestDb())
  workspaceId = (await createWorkspaceRepo(db, () => FIXED_NOW).create('/r', 'main', 'r', 'r')).id
  repo = createLineupRepo(db)
})
afterEach(() => cleanup())

/** What the settings screen sends back for a role it read. */
function input({ workspaceId: _w, lineup: _l, position: _p, ...rest }: LineupRole): LineupRoleInput {
  return rest
}

function newRole(id: string, name: string, extra: Partial<LineupRoleInput> = {}): LineupRoleInput {
  return {
    id,
    name,
    instructions: `Be the ${name}.`,
    activePhase: 'testing',
    onProblem: 'ask_me',
    handBackTo: null,
    model: null,
    effort: null,
    toolProfile: 'read_only',
    ...extra
  }
}

describe('default lineup', () => {
  it('tells the Implementer to run related tests and the full type check, and the Reviewer to run everything', () => {
    const [planner, implementer, reviewer] = defaultLineup()
    expect(implementer!.instructions).toContain('run only the tests that cover the code you changed')
    expect(implementer!.instructions).toContain('full type check (or its build, if it has no type check)')
    expect(implementer!.instructions).toContain('say which tests you ran')
    expect(implementer!.instructions).toContain("Don't tick a criterion about the full test suite: the Reviewer runs it.")
    expect(reviewer!.instructions).toContain('run the full test suite, every kind the project has (end-to-end tests included)')
    expect(planner!.instructions).toMatch(/^Read the ticket and the code it touches./)
  })
})

describe('lineup repo', () => {
  it('reorders, renames and edits roles, keeping their ids', async () => {
    const [planner, implementer, reviewer] = await repo.get(workspaceId)
    const saved = await repo.save(workspaceId, [
      { ...input(implementer!), handBackTo: null },
      { ...input(planner!), name: '  Architect ', model: 'opus', effort: 'high' },
      input(reviewer!)
    ])
    expect(saved.map((r) => [r.position, r.id, r.name])).toEqual([
      [1, implementer!.id, 'Implementer'],
      [2, planner!.id, 'Architect'],
      [3, reviewer!.id, 'Reviewer']
    ])
    expect(saved[1]).toMatchObject({ model: 'opus', effort: 'high' })
    expect(await repo.get(workspaceId)).toEqual(saved)
  })

  it('gives a new role a fresh id that a later role can hand back to', async () => {
    const [planner, implementer] = await repo.get(workspaceId)
    const saved = await repo.save(workspaceId, [
      input(planner!),
      newRole('new-1', 'Tester'),
      { ...input(implementer!), handBackTo: 'new-1' }
    ])
    const tester = saved[1]!
    expect(tester.id).not.toBe('new-1')
    expect(tester.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(saved[2]).toMatchObject({ id: implementer!.id, handBackTo: tester.id })
  })

  it('a role that handed back to a removed role falls back to the previous role', async () => {
    const [, implementer, reviewer] = await repo.get(workspaceId)
    const saved = await repo.save(workspaceId, [input(reviewer!)])
    expect(saved).toEqual([{ ...reviewer!, position: 1, handBackTo: null }])
    // The implementer is gone, so a reference to it falls back too.
    expect((await repo.save(workspaceId, [newRole('n', 'A'), { ...input(reviewer!), handBackTo: implementer!.id }]))[1]!.handBackTo).toBeNull()
  })

  it('a role that asks the user stores no hand-back', async () => {
    const [planner, implementer] = await repo.get(workspaceId)
    const saved = await repo.save(workspaceId, [input(planner!), { ...input(implementer!), onProblem: 'ask_me' }])
    expect(saved[1]!.handBackTo).toBeNull()
  })

  it.each([
    ['no roles', [], 'A lineup needs at least one role.'],
    ['an empty name', [newRole('a', '  ')], 'Role 1 needs a name.'],
    ['a duplicate name, in any case', [newRole('a', 'Tester'), newRole('b', 'tester ')], 'Two roles are called "Tester". Give each role its own name.'],
    [
      'a hand-back to a later role',
      [newRole('a', 'First', { onProblem: 'hand_back', handBackTo: 'b' }), newRole('b', 'Second')],
      "First hands back to Second, which doesn't come before it. A role can only hand back to an earlier role."
    ],
    [
      'a hand-back to itself',
      [newRole('a', 'Only', { onProblem: 'hand_back', handBackTo: 'a' })],
      "Only hands back to Only, which doesn't come before it. A role can only hand back to an earlier role."
    ]
  ])('rejects %s and changes nothing', async (_, roles, message) => {
    const before = await repo.get(workspaceId)
    await expect(repo.save(workspaceId, roles as LineupRoleInput[])).rejects.toThrow(message)
    expect(await repo.get(workspaceId)).toEqual(before)
  })

  it('rejects values the settings screen never sends', () => {
    expect(lineupProblem([newRole('a', 'A', { activePhase: 'done' as never })])).toBe('A has an unknown phase.')
    expect(lineupProblem([newRole('a', 'A', { toolProfile: 'root' as never })])).toBe('A has an unknown tool profile.')
    expect(lineupProblem([newRole('a', 'A', { onProblem: 'panic' as never })])).toBe('A has an unknown "on a problem" setting.')
    expect(lineupProblem([newRole('a', 'A', { effort: 'huge' as never })])).toBe('A has an unknown effort.')
    expect(lineupProblem([newRole('a', 'A'), newRole('a', 'B')])).toBe('Two roles have the same id (a).')
  })

  it("saving one workspace's lineup leaves another's alone, and never takes over its ids", async () => {
    const other = (await createWorkspaceRepo(db, () => FIXED_NOW).create('/o', 'main', 'o', 'o')).id
    const theirs = await repo.get(other)
    const saved = await repo.save(workspaceId, [newRole(theirs[0]!.id, 'Solo')])
    expect(saved[0]!.id).not.toBe(theirs[0]!.id)
    expect(await repo.get(other)).toEqual(theirs)
  })
})

describe('investigate lineup', () => {
  it('a new workspace has both lineups', async () => {
    const [investigator] = defaultInvestigateLineup()
    expect(await repo.get(workspaceId, 'investigate')).toMatchObject([{ ...investigator, id: expect.any(String), lineup: 'investigate', position: 1 }])
    expect((await repo.get(workspaceId)).map((r) => r.name)).toEqual(['Planner', 'Implementer', 'Reviewer'])
  })

  it('saving one lineup leaves the other alone', async () => {
    const change = (await repo.get(workspaceId)).map(input)
    const saved = await repo.save(workspaceId, [newRole('a', 'Looker'), newRole('b', 'Writer')], 'investigate')
    expect(saved.map((r) => [r.name, r.lineup, r.position])).toEqual([['Looker', 'investigate', 1], ['Writer', 'investigate', 2]])
    expect((await repo.get(workspaceId)).map(input)).toEqual(change)
    await repo.save(workspaceId, [newRole('c', 'Solo')])
    expect((await repo.get(workspaceId, 'investigate')).map((r) => r.name)).toEqual(['Looker', 'Writer'])
    expect((await repo.get(workspaceId)).map((r) => r.name)).toEqual(['Solo'])
  })
})
