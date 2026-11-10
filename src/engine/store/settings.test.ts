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

/** The Theme setting of a new user: Light, and Match Windows between Light and Dark. */
const LIGHT = { choice: 'light', light: 'light', dark: 'dark' } as const
/** The orchestrator of a new user: Opus at medium effort, as before there was a setting. */
const ORCHESTRATOR = { orchestratorModel: 'opus', orchestratorEffort: 'medium', reviewDoneTickets: true, reviewDoneWaitMinutes: 2 } as const

describe('settings repo', () => {
  it('allows three agents at once until the user says otherwise', async () => {
    expect(await createSettingsRepo(db).get()).toEqual({ maxAgents: 3, whenClosed: 'tray', orchestratorWebAccess: true, ...ORCHESTRATOR, theme: LIGHT })
  })

  it('stores the number of agents, and a second repo over the same database reads it', async () => {
    expect(await createSettingsRepo(db).setMaxAgents(5)).toEqual({ maxAgents: 5, whenClosed: 'tray', orchestratorWebAccess: true, ...ORCHESTRATOR, theme: LIGHT })
    await createSettingsRepo(db).setMaxAgents(1)
    expect(await createSettingsRepo(db).get()).toEqual({ maxAgents: 1, whenClosed: 'tray', orchestratorWebAccess: true, ...ORCHESTRATOR, theme: LIGHT })
  })

  it.each([0, 11, 2.5, -1, Number.NaN, '3' as unknown as number])('refuses %s', async (n) => {
    await expect(createSettingsRepo(db).setMaxAgents(n)).rejects.toThrow('from 1 to 10')
    expect(await createSettingsRepo(db).get()).toEqual({ maxAgents: 3, whenClosed: 'tray', orchestratorWebAccess: true, ...ORCHESTRATOR, theme: LIGHT })
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
    expect(await createSettingsRepo(db).get()).toEqual({ maxAgents: 3, whenClosed: 'tray', orchestratorWebAccess: true, ...ORCHESTRATOR, theme: LIGHT })
  })

  it('keeps running in the tray when the window closes until the user says otherwise, and remembers the choice', async () => {
    expect((await createSettingsRepo(db).get()).whenClosed).toBe('tray')
    expect(await createSettingsRepo(db).setWhenClosed('quit')).toEqual({ maxAgents: 3, whenClosed: 'quit', orchestratorWebAccess: true, ...ORCHESTRATOR, theme: LIGHT })
    expect((await createSettingsRepo(db).get()).whenClosed).toBe('quit')
    await createSettingsRepo(db).setWhenClosed('tray')
    expect((await createSettingsRepo(db).get()).whenClosed).toBe('tray')
  })

  it.each(['never', '', null, 1])('refuses %s as what to do on close, and an unknown stored value reads as the tray', async (v) => {
    await expect(createSettingsRepo(db).setWhenClosed(v as unknown as 'tray')).rejects.toThrow("'tray' or 'quit'")
    await db.insert(appSettings).values({ key: 'when_closed', value: 'bogus' })
    expect((await createSettingsRepo(db).get()).whenClosed).toBe('tray')
  })

  it('lets the orchestrator read web pages until the user says otherwise, and remembers the choice', async () => {
    expect((await createSettingsRepo(db).get()).orchestratorWebAccess).toBe(true)
    expect((await createSettingsRepo(db).setOrchestratorWebAccess(false)).orchestratorWebAccess).toBe(false)
    expect((await createSettingsRepo(db).get()).orchestratorWebAccess).toBe(false)
    expect((await createSettingsRepo(db).setOrchestratorWebAccess(true)).orchestratorWebAccess).toBe(true)
    await expect(createSettingsRepo(db).setOrchestratorWebAccess('off' as unknown as boolean)).rejects.toThrow('on or off')
  })

  it("runs the orchestrator on Opus at medium effort until the user says otherwise, and remembers each choice", async () => {
    expect(await createSettingsRepo(db).get()).toMatchObject(ORCHESTRATOR)
    expect(await createSettingsRepo(db).setOrchestratorModel('fable')).toMatchObject({ orchestratorModel: 'fable', orchestratorEffort: 'medium' })
    expect(await createSettingsRepo(db).setOrchestratorEffort('max')).toMatchObject({ orchestratorModel: 'fable', orchestratorEffort: 'max' })
    expect(await createSettingsRepo(db).get()).toMatchObject({ orchestratorModel: 'fable', orchestratorEffort: 'max' })
    await createSettingsRepo(db).setOrchestratorModel('sonnet')
    await createSettingsRepo(db).setOrchestratorEffort('xhigh')
    expect(await createSettingsRepo(db).get()).toMatchObject({ orchestratorModel: 'sonnet', orchestratorEffort: 'xhigh' })
  })

  it.each(['haiku', 'claude-opus-5-5', '', 3])("refuses %s as the orchestrator's model", async (m) => {
    await expect(createSettingsRepo(db).setOrchestratorModel(m as 'opus')).rejects.toThrow("The orchestrator's model must be 'fable', 'opus', 'sonnet'")
    expect((await createSettingsRepo(db).get()).orchestratorModel).toBe('opus')
  })

  it.each(['none', 'High', '', null])("refuses %s as the orchestrator's effort", async (e) => {
    await expect(createSettingsRepo(db).setOrchestratorEffort(e as 'high')).rejects.toThrow("The orchestrator's effort must be 'low', 'medium', 'high', 'xhigh', 'max'")
    expect((await createSettingsRepo(db).get()).orchestratorEffort).toBe('medium')
  })

  it('reads an orchestrator model or effort it does not know as the default', async () => {
    await db.insert(appSettings).values([
      { key: 'orchestrator_model', value: 'haiku' },
      { key: 'orchestrator_effort', value: 'turbo' }
    ])
    expect(await createSettingsRepo(db).get()).toMatchObject(ORCHESTRATOR)
  })

  it('draws the app in Light until the user picks, and remembers each theme and Match Windows', async () => {
    expect((await createSettingsRepo(db).get()).theme).toEqual(LIGHT)
    expect(await createSettingsRepo(db).setTheme('dark')).toEqual({ maxAgents: 3, whenClosed: 'tray', orchestratorWebAccess: true, ...ORCHESTRATOR, theme: { ...LIGHT, choice: 'dark' } })
    for (const choice of ['night-owl', 'light-owl', 'system', 'dark', 'light'] as const) {
      await createSettingsRepo(db).setTheme(choice)
      expect((await createSettingsRepo(db).get()).theme).toEqual({ ...LIGHT, choice })
    }
  })

  it.each(['auto', 'Dark', 'Night Owl', '', null, 1])('refuses %s as the theme, and an unknown stored value reads as Light', async (v) => {
    await expect(createSettingsRepo(db).setTheme(v as unknown as 'dark')).rejects.toThrow("'light', 'dark', 'night-owl', 'light-owl' or 'system'")
    await db.insert(appSettings).values({ key: 'theme', value: 'bogus' })
    expect((await createSettingsRepo(db).get()).theme).toEqual(LIGHT)
  })

  it.each(['light', 'dark', 'system'] as const)('a %s stored before named themes reads as it did, with Light and Dark for Match Windows', async (v) => {
    // The rows as the app wrote them before: just the choice.
    await db.insert(appSettings).values({ key: 'theme', value: v })
    expect((await createSettingsRepo(db).get()).theme).toEqual({ choice: v, light: 'light', dark: 'dark' })
  })

  it('remembers the light and the dark theme Match Windows uses, and keeps the choice', async () => {
    await createSettingsRepo(db).setTheme('system')
    expect((await createSettingsRepo(db).setMatchWindowsTheme('dark', 'night-owl')).theme).toEqual({ choice: 'system', light: 'light', dark: 'night-owl' })
    await createSettingsRepo(db).setMatchWindowsTheme('light', 'light-owl')
    expect((await createSettingsRepo(db).get()).theme).toEqual({ choice: 'system', light: 'light-owl', dark: 'night-owl' })
    // Picking a theme outright leaves the Match Windows picks for next time.
    await createSettingsRepo(db).setTheme('dark')
    expect((await createSettingsRepo(db).get()).theme).toEqual({ choice: 'dark', light: 'light-owl', dark: 'night-owl' })
  })

  it.each([
    ['dark', 'light-owl'],
    ['light', 'night-owl'],
    ['dark', 'system'],
    ['dark', 'bogus'],
    ['dim', 'dark']
  ])('refuses %s %s for Match Windows', async (scheme, id) => {
    await expect(createSettingsRepo(db).setMatchWindowsTheme(scheme as 'dark', id as 'dark')).rejects.toThrow()
    expect((await createSettingsRepo(db).get()).theme).toEqual(LIGHT)
  })

  it('a stored Match Windows theme of the wrong scheme, or unknown, reads as Light or Dark', async () => {
    await db.insert(appSettings).values([
      { key: 'theme_light', value: 'night-owl' },
      { key: 'theme_dark', value: 'bogus' }
    ])
    expect((await createSettingsRepo(db).get()).theme).toEqual(LIGHT)
  })

  it('accepts both ends of the range', async () => {
    await createSettingsRepo(db).setMaxAgents(10)
    expect((await createSettingsRepo(db).get()).maxAgents).toBe(10)
    await createSettingsRepo(db).setMaxAgents(1)
    expect((await createSettingsRepo(db).get()).maxAgents).toBe(1)
  })
})

describe('the review of finished tickets', () => {
  it('is on with a two-minute wait until the user says otherwise', async () => {
    expect(await createSettingsRepo(db).get()).toMatchObject({ reviewDoneTickets: true, reviewDoneWaitMinutes: 2 })
  })

  it('stores the switch and the wait separately', async () => {
    expect(await createSettingsRepo(db).setReviewDone({ on: false })).toMatchObject({ reviewDoneTickets: false, reviewDoneWaitMinutes: 2 })
    expect(await createSettingsRepo(db).setReviewDone({ waitMinutes: 10 })).toMatchObject({ reviewDoneTickets: false, reviewDoneWaitMinutes: 10 })
    expect(await createSettingsRepo(db).setReviewDone({ on: true })).toMatchObject({ reviewDoneTickets: true, reviewDoneWaitMinutes: 10 })
  })

  it('rejects anything but a boolean and a whole number of minutes from 1 to 30', async () => {
    const repo = createSettingsRepo(db)
    await expect(repo.setReviewDone({ on: 'off' as unknown as boolean })).rejects.toThrow('on or off')
    for (const bad of [0, 31, 1.5, Number.NaN, '5' as unknown as number]) {
      await expect(repo.setReviewDone({ waitMinutes: bad })).rejects.toThrow('whole number of minutes from 1 to 30')
    }
    expect((await repo.get()).reviewDoneWaitMinutes).toBe(2)
  })
})
