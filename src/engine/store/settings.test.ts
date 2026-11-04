import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db/open'
import { appSettings } from '../db/schema'
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
    expect(await createSettingsRepo(db).get()).toEqual({ maxAgents: 3, whenClosed: 'tray', theme: 'light' })
  })

  it('stores the number of agents, and a second repo over the same database reads it', async () => {
    expect(await createSettingsRepo(db).setMaxAgents(5)).toEqual({ maxAgents: 5, whenClosed: 'tray', theme: 'light' })
    await createSettingsRepo(db).setMaxAgents(1)
    expect(await createSettingsRepo(db).get()).toEqual({ maxAgents: 1, whenClosed: 'tray', theme: 'light' })
  })

  it.each([0, 11, 2.5, -1, Number.NaN, '3' as unknown as number])('refuses %s', async (n) => {
    await expect(createSettingsRepo(db).setMaxAgents(n)).rejects.toThrow('from 1 to 10')
    expect(await createSettingsRepo(db).get()).toEqual({ maxAgents: 3, whenClosed: 'tray', theme: 'light' })
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
    expect(await createSettingsRepo(db).get()).toEqual({ maxAgents: 3, whenClosed: 'tray', theme: 'light' })
  })

  it('keeps running in the tray when the window closes until the user says otherwise, and remembers the choice', async () => {
    expect((await createSettingsRepo(db).get()).whenClosed).toBe('tray')
    expect(await createSettingsRepo(db).setWhenClosed('quit')).toEqual({ maxAgents: 3, whenClosed: 'quit', theme: 'light' })
    expect((await createSettingsRepo(db).get()).whenClosed).toBe('quit')
    await createSettingsRepo(db).setWhenClosed('tray')
    expect((await createSettingsRepo(db).get()).whenClosed).toBe('tray')
  })

  it.each(['never', '', null, 1])('refuses %s as what to do on close, and an unknown stored value reads as the tray', async (v) => {
    await expect(createSettingsRepo(db).setWhenClosed(v as unknown as 'tray')).rejects.toThrow("'tray' or 'quit'")
    await db.insert(appSettings).values({ key: 'when_closed', value: 'bogus' })
    expect((await createSettingsRepo(db).get()).whenClosed).toBe('tray')
  })

  it('draws the app in Light until the user picks, and remembers Dark and Match Windows', async () => {
    expect((await createSettingsRepo(db).get()).theme).toBe('light')
    expect(await createSettingsRepo(db).setTheme('dark')).toEqual({ maxAgents: 3, whenClosed: 'tray', theme: 'dark' })
    expect((await createSettingsRepo(db).get()).theme).toBe('dark')
    await createSettingsRepo(db).setTheme('system')
    expect((await createSettingsRepo(db).get()).theme).toBe('system')
    await createSettingsRepo(db).setTheme('light')
    expect((await createSettingsRepo(db).get()).theme).toBe('light')
  })

  it.each(['auto', 'Dark', '', null, 1])('refuses %s as the theme, and an unknown stored value reads as Light', async (v) => {
    await expect(createSettingsRepo(db).setTheme(v as unknown as 'dark')).rejects.toThrow("'light', 'dark' or 'system'")
    await db.insert(appSettings).values({ key: 'theme', value: 'bogus' })
    expect((await createSettingsRepo(db).get()).theme).toBe('light')
  })

  it('accepts both ends of the range', async () => {
    await createSettingsRepo(db).setMaxAgents(10)
    expect((await createSettingsRepo(db).get()).maxAgents).toBe(10)
    await createSettingsRepo(db).setMaxAgents(1)
    expect((await createSettingsRepo(db).get()).maxAgents).toBe(1)
  })
})
