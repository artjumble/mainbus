import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db/open'
import { createLineupRepo, defaultLineup } from './lineups'
import { FIXED_NOW, openTestDb } from './testDb'
import { createWorkspaceRepo } from './workspaces'

let db: Db
let cleanup: () => void

beforeEach(async () => {
  ;({ db, cleanup } = await openTestDb())
})
afterEach(() => cleanup())

describe('workspace repo', () => {
  it('returns null before a workspace exists', async () => {
    expect(await createWorkspaceRepo(db, () => FIXED_NOW).get()).toBeNull()
  })

  it('creates a workspace and reads it back', async () => {
    const repo = createWorkspaceRepo(db, () => FIXED_NOW)
    const created = await repo.create('C:\\code\\my-app', 'main', 'my-app', 'my-app')
    expect(created).toEqual({
      id: expect.any(String),
      name: 'my-app',
      repoPath: 'C:\\code\\my-app',
      baseBranch: 'main',
      slug: 'my-app',
      openPrOnReview: false
    })
    expect(await repo.get()).toEqual(created)
  })

  it('switches opening a PR on Review on and off', async () => {
    const repo = createWorkspaceRepo(db, () => FIXED_NOW)
    const ws = await repo.create('/r', 'main', 'r', 'r')
    expect((await repo.setOpenPrOnReview(ws.id, true)).openPrOnReview).toBe(true)
    expect((await repo.get())?.openPrOnReview).toBe(true)
    expect((await repo.setOpenPrOnReview(ws.id, false)).openPrOnReview).toBe(false)
  })

  it('creating a workspace creates the default Planner → Implementer → Reviewer lineup', async () => {
    const ws = await createWorkspaceRepo(db, () => FIXED_NOW).create('/r', 'main', 'r', 'r')
    const lineup = await createLineupRepo(db).get(ws.id)
    expect(lineup.map(({ name, position, activePhase, toolProfile, onProblem, model, effort }) => ({
      name, position, activePhase, toolProfile, onProblem, model, effort
    }))).toEqual([
      { name: 'Planner', position: 1, activePhase: 'planning', toolProfile: 'read_only', onProblem: 'ask_me', model: null, effort: null },
      { name: 'Implementer', position: 2, activePhase: 'implementing', toolProfile: 'edit', onProblem: 'hand_back', model: null, effort: null },
      { name: 'Reviewer', position: 3, activePhase: 'reviewing', toolProfile: 'read_only', onProblem: 'hand_back', model: null, effort: null }
    ])
    const [planner, implementer, reviewer] = lineup
    expect(lineup.every((r) => r.workspaceId === ws.id && r.lineup === 'change')).toBe(true)
    expect(planner!.handBackTo).toBeNull()
    expect(implementer!.handBackTo).toBe(planner!.id)
    expect(reviewer!.handBackTo).toBe(implementer!.id)
    expect(lineup.map((r) => r.instructions)).toEqual(defaultLineup().map((r) => r.instructions))
    expect(reviewer!.instructions).toContain('report it as a problem with specific findings')
  })
})
