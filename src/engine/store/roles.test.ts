import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db/open'
import { createRoleRepo } from './roles'
import { FIXED_NOW, openTestDb } from './testDb'
import { createWorkspaceRepo } from './workspaces'

let db: Db
let cleanup: () => void
let workspaceId: string

beforeEach(async () => {
  ;({ db, cleanup } = await openTestDb())
  workspaceId = (await createWorkspaceRepo(db, () => FIXED_NOW).create('/r', 'main', 'r', 'r')).id
})
afterEach(() => cleanup())

describe('role repo', () => {
  it('updates only the fields in the patch', async () => {
    const repo = createRoleRepo(db)
    const updated = await repo.update(workspaceId, { instructions: 'Be terse.', model: 'opus', effort: 'high' })
    expect(updated).toMatchObject({ instructions: 'Be terse.', model: 'opus', effort: 'high', name: 'Implementer' })
    expect(await repo.get(workspaceId)).toEqual(updated)

    const cleared = await repo.update(workspaceId, { model: null })
    expect(cleared.model).toBeNull()
    expect(cleared.effort).toBe('high')
  })

  it('an empty patch changes nothing', async () => {
    const repo = createRoleRepo(db)
    const before = await repo.get(workspaceId)
    expect(await repo.update(workspaceId, {})).toEqual(before)
  })

  it('throws for a workspace with no role', async () => {
    await expect(createRoleRepo(db).get('missing')).rejects.toThrow(/role/i)
  })
})
