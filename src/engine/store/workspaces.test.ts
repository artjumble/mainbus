import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db/open'
import { createRoleRepo } from './roles'
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
      slug: 'my-app'
    })
    expect(await repo.get()).toEqual(created)
  })

  it('creating a workspace creates its default Implementer role', async () => {
    const ws = await createWorkspaceRepo(db, () => FIXED_NOW).create('/r', 'main', 'r', 'r')
    expect(await createRoleRepo(db).get(ws.id)).toEqual({
      workspaceId: ws.id,
      name: 'Implementer',
      instructions: 'Make the change and its tests. Commit your work on the branch before handing off.',
      activePhase: 'implementing',
      toolProfile: 'edit',
      model: null,
      effort: null
    })
  })
})
