import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PRESET_NAME_MAX, type RunSettings } from '../../shared/domain'
import { presetRunSettings } from '../../shared/runSettings'
import type { Db } from '../db/open'
import { createLineupRepo } from './lineups'
import { createPresetRepo, defaultPresets, type PresetRepo } from './presets'
import { FIXED_NOW, openTestDb } from './testDb'
import { createWorkspaceRepo } from './workspaces'

let db: Db
let cleanup: () => void
let workspaceId: string
let repo: PresetRepo

beforeEach(async () => {
  ;({ db, cleanup } = await openTestDb())
  workspaceId = (await createWorkspaceRepo(db, () => FIXED_NOW).create('/r', 'main', 'r', 'r')).id
  repo = createPresetRepo(db, () => FIXED_NOW)
})
afterEach(() => cleanup())

const NONE: RunSettings = { excludedRoleIds: [], roles: {}, extraInstructions: null, roleNames: {} }

describe('the built-in presets', () => {
  it('seeds a new workspace with Full, Quick fix and Docs, in that order', async () => {
    const lineup = await createLineupRepo(db).get(workspaceId)
    const [planner, implementer, reviewer] = lineup
    const presets = await repo.list(workspaceId)
    expect(presets.map((p) => p.name)).toEqual(['Full', 'Quick fix', 'Docs'])
    expect(presets[0]!.settings).toEqual(NONE)
    expect(presets[1]!.settings).toEqual({ ...NONE, excludedRoleIds: [planner!.id], roleNames: { [planner!.id]: 'Planner' } })
    expect(presets[2]!.settings).toEqual({
      excludedRoleIds: [planner!.id, reviewer!.id],
      roles: { [implementer!.id]: { model: 'sonnet', effort: 'medium' } },
      extraInstructions: null,
      roleNames: { [planner!.id]: 'Planner', [implementer!.id]: 'Implementer', [reviewer!.id]: 'Reviewer' }
    })
  })

  it('does not share presets between workspaces', async () => {
    const other = await createWorkspaceRepo(db, () => FIXED_NOW).create('/o', 'main', 'o', 'o')
    expect(await repo.list(other.id)).toHaveLength(3)
    const [full] = await repo.list(workspaceId)
    await repo.remove(full!.id)
    expect((await repo.list(workspaceId)).map((p) => p.name)).toEqual(['Quick fix', 'Docs'])
    expect(await repo.list(other.id)).toHaveLength(3)
  })

  it('uses placeholder ids for a Planner or Implementer the lineup lacks, which apply with a notice', () => {
    const lineup = [
      { id: 'a1', name: 'Architect', model: null, effort: null },
      { id: 'r1', name: 'Reviewer', model: null, effort: null }
    ]
    const [full, quick, docs] = defaultPresets(lineup)
    expect(full!.settings).toEqual(NONE)
    expect(quick!.settings.excludedRoleIds).toEqual(['planner'])
    expect(docs!.settings.excludedRoleIds).toEqual(['a1', 'r1'])
    expect(docs!.settings.roles).toEqual({ implementer: { model: 'sonnet', effort: 'medium' } })
    const applied = presetRunSettings({ name: 'Quick fix', settings: quick!.settings }, lineup)
    expect(applied.notices).toEqual(["Planner isn't in this lineup, so the Quick fix preset's setting for it was dropped."])
    expect(applied.settings).toBeNull()
  })
})

describe('managing presets', () => {
  it('adds a preset last, with its settings', async () => {
    const saved = await repo.save(workspaceId, { name: '  Spike  ', settings: { ...NONE, extraInstructions: 'Be quick.' } })
    expect(saved).toMatchObject({ name: 'Spike', workspaceId })
    const presets = await repo.list(workspaceId)
    expect(presets.map((p) => p.name)).toEqual(['Full', 'Quick fix', 'Docs', 'Spike'])
    expect(presets[3]!.settings.extraInstructions).toBe('Be quick.')
    expect(await repo.get(saved.id)).toEqual(saved)
  })

  it('edits and renames a preset, keeping its place', async () => {
    const [, quick] = await repo.list(workspaceId)
    await repo.save(workspaceId, { id: quick!.id, name: 'Small fix', settings: { ...quick!.settings, extraInstructions: 'Tiny diff.' } })
    const presets = await repo.list(workspaceId)
    expect(presets.map((p) => p.name)).toEqual(['Full', 'Small fix', 'Docs'])
    expect(presets[1]).toMatchObject({ id: quick!.id, settings: { extraInstructions: 'Tiny diff.' } })
  })

  it('removes a preset; removing it twice is harmless', async () => {
    const [full] = await repo.list(workspaceId)
    await repo.remove(full!.id)
    await repo.remove(full!.id)
    expect(await repo.get(full!.id)).toBeNull()
    expect((await repo.list(workspaceId)).map((p) => p.name)).toEqual(['Quick fix', 'Docs'])
  })

  it('a new preset goes last even after the first ones were removed', async () => {
    const [full, quick] = await repo.list(workspaceId)
    await repo.remove(full!.id)
    await repo.remove(quick!.id)
    await repo.save(workspaceId, { name: 'A', settings: NONE })
    await repo.save(workspaceId, { name: 'B', settings: NONE })
    expect((await repo.list(workspaceId)).map((p) => p.name)).toEqual(['Docs', 'A', 'B'])
  })

  it.each([
    ['', 'A preset needs a name.'],
    ['   ', 'A preset needs a name.'],
    ['two\nlines', 'A preset name must be on one line.'],
    ['x'.repeat(PRESET_NAME_MAX + 1), `at most ${PRESET_NAME_MAX} characters`],
    ['docs', 'There is already a preset called "docs".'],
    ['  FULL ', 'There is already a preset called "FULL".']
  ])('refuses the name %j', async (name, message) => {
    await expect(repo.save(workspaceId, { name, settings: NONE })).rejects.toThrow(message)
    expect(await repo.list(workspaceId)).toHaveLength(3)
  })

  it('lets a preset keep its own name when edited, and refuses another to take a name', async () => {
    const [full, quick] = await repo.list(workspaceId)
    await repo.save(workspaceId, { id: full!.id, name: 'full', settings: NONE })
    await expect(repo.save(workspaceId, { id: quick!.id, name: 'FULL', settings: NONE })).rejects.toThrow('already a preset')
  })

  it('refuses to edit a preset that is gone', async () => {
    const [full] = await repo.list(workspaceId)
    await repo.remove(full!.id)
    await expect(repo.save(workspaceId, { id: full!.id, name: 'Full', settings: NONE })).rejects.toThrow('no longer exists')
  })
})
