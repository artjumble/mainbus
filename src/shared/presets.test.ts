import { describe, expect, it } from 'vitest'
import type { RunSettings } from './domain'
import { findPreset, presetNames, presetRunSettings } from './runSettings'

const lineup = [
  { id: 'p', name: 'Planner', model: null, effort: null },
  { id: 'i', name: 'Implementer', model: null, effort: null },
  { id: 'r', name: 'Reviewer', model: null, effort: null }
]
const settings = (patch: Partial<RunSettings>): RunSettings => ({ excludedRoleIds: [], roles: {}, extraInstructions: null, roleNames: {}, ...patch })

describe('presetRunSettings', () => {
  it('comes to nothing for a preset that is the lineup defaults', () => {
    expect(presetRunSettings({ name: 'Full', settings: settings({}) }, lineup)).toEqual({ settings: null, notices: [] })
  })

  it('keeps the exclusions, models and extra instructions of a preset that fits', () => {
    const docs = settings({
      excludedRoleIds: ['p', 'r'],
      roles: { i: { model: 'sonnet', effort: 'medium' } },
      extraInstructions: 'Docs only.',
      roleNames: { p: 'Planner', i: 'Implementer', r: 'Reviewer' }
    })
    expect(presetRunSettings({ name: 'Docs', settings: docs }, lineup)).toEqual({ settings: docs, notices: [] })
  })

  it('drops a role the lineup lacks, with a notice that names the preset, and the name it kept', () => {
    const preset = settings({ excludedRoleIds: ['gone'], roles: { i: { effort: 'low' } }, roleNames: { gone: 'Planner', i: 'Implementer' } })
    const applied = presetRunSettings({ name: 'Quick fix', settings: preset }, lineup)
    expect(applied.notices).toEqual(["Planner isn't in this lineup, so the Quick fix preset's setting for it was dropped."])
    expect(applied.settings).toEqual(settings({ roles: { i: { effort: 'low' } }, roleNames: { i: 'Implementer' } }))
  })

  it('runs the whole lineup, with a notice, when the preset leaves every role out', () => {
    const preset = settings({ excludedRoleIds: ['p', 'i', 'r'] })
    const applied = presetRunSettings({ name: 'Nothing', settings: preset }, lineup)
    expect(applied.notices).toEqual(['Every role in the lineup was left out, so the whole lineup runs.'])
    expect(applied.settings).toBeNull()
  })
})

describe('findPreset', () => {
  const presets = [{ name: 'Full' }, { name: 'Quick fix' }]
  it('matches ignoring case and spaces around the name', () => {
    expect(findPreset(presets, '  quick FIX ')).toBe(presets[1])
    expect(findPreset(presets, 'Docs')).toBeUndefined()
  })
  it('lists the names, or none', () => {
    expect(presetNames(presets)).toBe('Full, Quick fix')
    expect(presetNames([])).toBe('none')
  })
})
