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
    expect(await createWorkspaceRepo(db, () => FIXED_NOW).focused()).toBeNull()
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
      openPrOnReview: false,
      saveReports: true,
      reportsFolder: 'docs/investigations',
      setupCommand: '',
      setupTimeoutMinutes: 15
    })
    expect(await repo.get(created.id)).toEqual(created)
  })

  it('saves the report settings: on by default, a folder inside the repo, and refuses one that leaves it', async () => {
    const repo = createWorkspaceRepo(db, () => FIXED_NOW)
    const ws = await repo.create('/r', 'main', 'r', 'r')
    expect((await repo.setReportSettings(ws.id, { saveReports: false })).saveReports).toBe(false)
    expect(await repo.get(ws.id)).toMatchObject({ saveReports: false, reportsFolder: 'docs/investigations' })
    // Stored the one way: forward slashes, no "." segments or trailing slash.
    expect((await repo.setReportSettings(ws.id, { reportsFolder: ' .\\notes\\reports\\ ' })).reportsFolder).toBe('notes/reports')
    for (const outside of ['../elsewhere', 'docs/../../x', 'C:\\reports', '/abs', '.git/reports', '', '  ']) {
      await expect(repo.setReportSettings(ws.id, { saveReports: true, reportsFolder: outside })).rejects.toThrow()
    }
    // A refused folder saves nothing, not even the switch beside it.
    expect(await repo.get(ws.id)).toMatchObject({ saveReports: false, reportsFolder: 'notes/reports' })
  })

  it('saves the setup settings: empty and 15 minutes by default, a one-line command, a timeout of 1 to 60 whole minutes', async () => {
    const repo = createWorkspaceRepo(db, () => FIXED_NOW)
    const ws = await repo.create('/r', 'main', 'r', 'r')
    expect(ws).toMatchObject({ setupCommand: '', setupTimeoutMinutes: 15 })
    expect(await repo.setSetupSettings(ws.id, { command: '  npm ci  ' })).toMatchObject({ setupCommand: 'npm ci', setupTimeoutMinutes: 15 })
    expect(await repo.setSetupSettings(ws.id, { timeoutMinutes: 60 })).toMatchObject({ setupCommand: 'npm ci', setupTimeoutMinutes: 60 })
    for (const timeoutMinutes of [0, 61, 1.5, -1, Number.NaN]) {
      await expect(repo.setSetupSettings(ws.id, { command: 'x', timeoutMinutes })).rejects.toThrow(/whole number/)
    }
    await expect(repo.setSetupSettings(ws.id, { command: 'npm ci\nrm -rf x' })).rejects.toThrow(/one line/)
    await expect(repo.setSetupSettings(ws.id, { command: 'x'.repeat(1001) })).rejects.toThrow(/at most/)
    // A refused value saves nothing, not even the one beside it.
    expect(await repo.get(ws.id)).toMatchObject({ setupCommand: 'npm ci', setupTimeoutMinutes: 60 })
    expect(await repo.setSetupSettings(ws.id, { command: '' })).toMatchObject({ setupCommand: '' })
  })

  it('switches opening a PR on Review on and off', async () => {
    const repo = createWorkspaceRepo(db, () => FIXED_NOW)
    const ws = await repo.create('/r', 'main', 'r', 'r')
    expect((await repo.setOpenPrOnReview(ws.id, true)).openPrOnReview).toBe(true)
    expect((await repo.get(ws.id))?.openPrOnReview).toBe(true)
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

  it('lists the live workspaces oldest first and gives clashing slugs a number', async () => {
    let tick = 0
    const repo = createWorkspaceRepo(db, () => new Date(FIXED_NOW.getTime() + tick++))
    const a = await repo.create('/one/app', 'main', 'app', 'app')
    const b = await repo.create('/two/app', 'main', 'app', 'app')
    const c = await repo.create('/three/app', 'dev', 'app')
    expect([a.slug, b.slug, c.slug]).toEqual(['app', 'app-2', 'app-3'])
    expect((await repo.list()).map((w) => w.id)).toEqual([a.id, b.id, c.id])
  })

  it('remembers the focused workspace and falls back to the oldest live one', async () => {
    let tick = 0
    const repo = createWorkspaceRepo(db, () => new Date(FIXED_NOW.getTime() + tick++))
    const a = await repo.create('/a', 'main', 'a')
    const b = await repo.create('/b', 'main', 'b')
    expect((await repo.focused())?.id).toBe(a.id)
    await repo.setFocused(b.id)
    expect((await repo.focused())?.id).toBe(b.id)
    await repo.markRemoved(b.id)
    expect((await repo.focused())?.id).toBe(a.id)
    expect(await repo.get(b.id)).toBeNull()
    expect((await repo.list()).map((w) => w.id)).toEqual([a.id])
  })

  it('keeps a removed workspace, still using its slug, and restores it', async () => {
    const repo = createWorkspaceRepo(db, () => FIXED_NOW)
    const a = await repo.create('/a/app', 'main', 'app')
    await repo.markRemoved(a.id)
    expect((await repo.listAll()).map((w) => [w.id, w.removed])).toEqual([[a.id, true]])
    expect((await repo.create('/b/app', 'main', 'app')).slug).toBe('app-2')
    await repo.restore(a.id)
    expect((await repo.get(a.id))?.id).toBe(a.id)
  })

  it('remembers unattended mode per workspace', async () => {
    const repo = createWorkspaceRepo(db, () => FIXED_NOW)
    const a = await repo.create('/a', 'main', 'a')
    const b = await repo.create('/b', 'main', 'b')
    await repo.setUnattendedOn(a.id, true)
    expect([await repo.unattendedOn(a.id), await repo.unattendedOn(b.id)]).toEqual([true, false])
    await repo.setUnattendedOn(a.id, false)
    expect(await repo.unattendedOn(a.id)).toBe(false)
  })
})
