import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db/open'
import { createSettingsRepo } from './settings'
import { openTestDb } from './testDb'

let db: Db
let cleanup: () => void
beforeEach(async () => {
  ;({ db, cleanup } = await openTestDb())
})
afterEach(() => cleanup())

describe('settings repo', () => {
  it('allows three agents at once until the user says otherwise', async () => {
    expect(await createSettingsRepo(db).get()).toEqual({ maxAgents: 3 })
  })

  it('stores the number of agents, and a second repo over the same database reads it', async () => {
    expect(await createSettingsRepo(db).setMaxAgents(5)).toEqual({ maxAgents: 5 })
    await createSettingsRepo(db).setMaxAgents(1)
    expect(await createSettingsRepo(db).get()).toEqual({ maxAgents: 1 })
  })

  it.each([0, 11, 2.5, -1, Number.NaN, '3' as unknown as number])('refuses %s', async (n) => {
    await expect(createSettingsRepo(db).setMaxAgents(n)).rejects.toThrow('from 1 to 10')
    expect(await createSettingsRepo(db).get()).toEqual({ maxAgents: 3 })
  })

  it('keeps the usage limit across a second repo, and clears it', async () => {
    expect(await createSettingsRepo(db).usageLimit()).toBeNull()
    await createSettingsRepo(db).setUsageLimit({ since: '2026-11-02T09:00:00.000Z', resetsAt: '2026-11-02T10:00:00.000Z' })
    expect(await createSettingsRepo(db).usageLimit()).toEqual({ since: '2026-11-02T09:00:00.000Z', resetsAt: '2026-11-02T10:00:00.000Z' })
    await createSettingsRepo(db).setUsageLimit({ since: '2026-11-02T09:00:00.000Z', resetsAt: null })
    expect(await createSettingsRepo(db).usageLimit()).toEqual({ since: '2026-11-02T09:00:00.000Z', resetsAt: null })
    await createSettingsRepo(db).setUsageLimit(null)
    expect(await createSettingsRepo(db).usageLimit()).toBeNull()
    // The agent cap is untouched.
    expect(await createSettingsRepo(db).get()).toEqual({ maxAgents: 3 })
  })

  it('accepts both ends of the range', async () => {
    await createSettingsRepo(db).setMaxAgents(10)
    expect((await createSettingsRepo(db).get()).maxAgents).toBe(10)
    await createSettingsRepo(db).setMaxAgents(1)
    expect((await createSettingsRepo(db).get()).maxAgents).toBe(1)
  })
})
