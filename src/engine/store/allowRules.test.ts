import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db/open'
import { createAllowRuleRepo } from './allowRules'
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

describe('allow rule repo', () => {
  it('adds, lists and removes rules for a workspace', async () => {
    const repo = createAllowRuleRepo(db)
    const other = await createWorkspaceRepo(db, () => FIXED_NOW).create('/o', 'main', 'o', 'o')
    const bash = await repo.add({ workspaceId, toolName: 'Bash', pattern: 'npm test' })
    const web = await repo.add({ workspaceId, toolName: 'WebFetch', pattern: null })
    await repo.add({ workspaceId: other.id, toolName: 'Bash', pattern: null })

    expect(bash).toEqual({ id: expect.any(String), workspaceId, toolName: 'Bash', pattern: 'npm test' })
    expect(await repo.list(workspaceId)).toEqual([bash, web])

    await repo.remove(bash.id)
    expect(await repo.list(workspaceId)).toEqual([web])
  })

  it('removing an unknown rule is a no-op', async () => {
    await expect(createAllowRuleRepo(db).remove('missing')).resolves.toBeUndefined()
  })
})
