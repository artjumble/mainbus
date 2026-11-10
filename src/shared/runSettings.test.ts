import { describe, expect, test } from 'vitest'
import type { RunSettings } from './domain'
import { ALIAS_MODEL_OPTIONS, setModelOptions } from './models'
import { applyRunSettings, checkRunSettings, choicesFromSettings, inputFromChoices, runSettingsSummary } from './runSettings'

const role = (id: string, name: string, over: { model?: string | null; effort?: 'low' | 'medium' | 'high' | null } = {}) => ({
  id,
  name,
  model: over.model ?? null,
  effort: over.effort ?? null
})
const LINEUP = [role('p', 'Planner'), role('i', 'Implementer'), role('r', 'Reviewer')]

const settings = (over: Partial<RunSettings> = {}): RunSettings => ({
  excludedRoleIds: [],
  roles: {},
  extraInstructions: null,
  roleNames: {},
  ...over
})

describe('applyRunSettings', () => {
  test('nothing saved: an empty start, so the lineup defaults run', () => {
    expect(applyRunSettings(null, LINEUP)).toEqual({ options: {}, notices: [], effective: null })
  })

  test('every role runs but the excluded ones, in lineup order, with the saved model, effort and instructions', () => {
    const saved = settings({ excludedRoleIds: ['p'], roles: { i: { model: 'opus', effort: 'high' } }, extraInstructions: 'Small diff.' })
    expect(applyRunSettings(saved, LINEUP)).toMatchObject({
      options: { roleIds: ['i', 'r'], roles: { i: { model: 'opus', effort: 'high' } }, extraInstructions: 'Small diff.' },
      notices: []
    })
  })

  test('a role added to the lineup later runs', () => {
    const saved = settings({ excludedRoleIds: ['p'] })
    const later = [LINEUP[0]!, role('t', 'Tester'), ...LINEUP.slice(1)]
    expect(applyRunSettings(saved, later).options.roleIds).toEqual(['t', 'i', 'r'])
  })

  test('a saved role that left the lineup is dropped, named in a notice', () => {
    const saved = settings({ excludedRoleIds: ['x'], roles: { y: { model: 'opus' } }, roleNames: { x: 'Tester', y: 'Docs writer' } })
    const applied = applyRunSettings(saved, LINEUP)
    expect(applied.options.roleIds).toEqual(['p', 'i', 'r'])
    expect(applied.options.roles).toBeUndefined()
    expect(applied.notices).toEqual([
      'Tester is no longer in the lineup, so its saved setting was dropped.',
      'Docs writer is no longer in the lineup, so its saved setting was dropped.'
    ])
    expect(applied.effective).toMatchObject({ excludedRoleIds: [], roles: {} })
  })

  test('saved Opus, Sonnet and Haiku are kept as they are once the binary offers Fable, and a saved Fable is kept too', () => {
    setModelOptions([{ value: 'claude-fable-5-2', label: 'Fable 5.2' }, ...ALIAS_MODEL_OPTIONS])
    try {
      const roles = { p: { model: 'opus' }, i: { model: 'claude-fable-5-2', effort: 'high' as const }, r: { model: 'haiku' } }
      const applied = applyRunSettings(settings({ roles }), LINEUP)
      expect(applied.options.roles).toEqual(roles)
      expect(applied.notices).toEqual([])
      expect(runSettingsSummary(applied.options, LINEUP)).toBe('Planner, Implementer, Reviewer · Planner on Opus, Implementer on Fable 5.2, high, Reviewer on Haiku')
    } finally {
      setModelOptions([])
    }
  })

  test('a saved Fable the binary no longer offers falls back to the default, named with its version', () => {
    const applied = applyRunSettings(settings({ roles: { i: { model: 'claude-fable-5-2' } } }), LINEUP)
    expect(applied.notices).toEqual(["Implementer's saved model Fable 5.2 is no longer available, so it uses the default."])
  })

  test('a model or effort no longer allowed falls back to the default, with a notice', () => {
    const saved = settings({ roles: { i: { model: 'gpt-4', effort: 'huge' as never }, r: { model: 'claude-old', effort: 'low' } } })
    const applied = applyRunSettings(saved, LINEUP)
    expect(applied.options.roles).toEqual({ r: { effort: 'low' } })
    expect(applied.notices).toEqual([
      "Implementer's saved model gpt-4 is no longer available, so it uses the default.",
      "Implementer's saved effort huge is no longer available, so it uses the default.",
      "Reviewer's saved model claude-old is no longer available, so it uses the default."
    ])
  })

  test("a model that is the role's own setting stays allowed", () => {
    const lineup = [role('i', 'Implementer', { model: 'claude-custom' })]
    expect(applyRunSettings(settings({ roles: { i: { model: 'claude-custom' } } }), lineup).notices).toEqual([])
  })

  test('with every role left out, the whole lineup runs, with a notice', () => {
    const applied = applyRunSettings(settings({ excludedRoleIds: ['p', 'i', 'r'] }), LINEUP)
    expect(applied.options.roleIds).toEqual(['p', 'i', 'r'])
    expect(applied.notices).toEqual(['Every role in the lineup was left out, so the whole lineup runs.'])
  })

  test("an excluded role's model and effort aren't in the start", () => {
    const applied = applyRunSettings(settings({ excludedRoleIds: ['p'], roles: { p: { model: 'haiku' } } }), LINEUP)
    expect(applied.options.roles).toBeUndefined()
  })
})

describe('runSettingsSummary', () => {
  test('the roles that run, the chosen models and effort, and extra instructions', () => {
    const saved = settings({ excludedRoleIds: ['r'], roles: { i: { model: 'opus', effort: 'high' }, p: { effort: 'low' } }, extraInstructions: 'x' })
    expect(runSettingsSummary(applyRunSettings(saved, LINEUP).options, LINEUP)).toBe(
      'Planner, Implementer · Planner on low effort, Implementer on Opus, high · extra instructions'
    )
    expect(runSettingsSummary(applyRunSettings(settings({ roles: { r: { model: 'haiku' } } }), LINEUP).options, LINEUP)).toBe(
      'Planner, Implementer, Reviewer · Reviewer on Haiku'
    )
    expect(runSettingsSummary({}, LINEUP)).toBe('Lineup defaults')
  })
})

describe('choicesFromSettings and inputFromChoices', () => {
  test('with nothing saved: every role ticked with its usual model and effort', () => {
    expect(choicesFromSettings(LINEUP, null)).toEqual([
      { roleId: 'p', name: 'Planner', ticked: true, model: 'opus', effort: 'high' },
      { roleId: 'i', name: 'Implementer', ticked: true, model: 'sonnet', effort: 'medium' },
      { roleId: 'r', name: 'Reviewer', ticked: true, model: 'opus', effort: 'medium' }
    ])
  })

  test('the saved settings fill the choices in', () => {
    const saved = settings({ excludedRoleIds: ['p'], roles: { i: { model: 'opus', effort: 'high' } } })
    expect(choicesFromSettings(LINEUP, saved).map((c) => [c.roleId, c.ticked, c.model, c.effort])).toEqual([
      ['p', false, 'opus', 'high'],
      ['i', true, 'opus', 'high'],
      ['r', true, 'opus', 'medium']
    ])
  })

  test('only what differs from the usual model and effort is kept, for the roles that run', () => {
    const choices = choicesFromSettings(LINEUP, null).map((c) =>
      c.roleId === 'p' ? { ...c, ticked: false, model: 'haiku' } : c.roleId === 'i' ? { ...c, model: 'opus' } : c
    )
    expect(inputFromChoices(choices, LINEUP, ' Note ')).toEqual({ excludedRoleIds: ['p'], roles: { i: { model: 'opus' } }, extraInstructions: ' Note ' })
    // Unchanged: nothing but the ticks.
    expect(inputFromChoices(choicesFromSettings(LINEUP, null), LINEUP, '')).toEqual({ excludedRoleIds: [], roles: {}, extraInstructions: '' })
  })
})

describe('checkRunSettings', () => {
  test('stores them with the role names, the instructions trimmed and blank ones as null', () => {
    expect(checkRunSettings({ excludedRoleIds: ['p'], roles: { i: { model: 'opus', effort: 'high' } }, extraInstructions: '  Go.  ' }, LINEUP)).toEqual({
      excludedRoleIds: ['p'],
      roles: { i: { model: 'opus', effort: 'high' } },
      extraInstructions: 'Go.',
      roleNames: { p: 'Planner', i: 'Implementer' }
    })
    expect(checkRunSettings({ excludedRoleIds: [], roles: {}, extraInstructions: '   ' }, LINEUP).extraInstructions).toBeNull()
  })

  test.each([
    [{ excludedRoleIds: ['zz'], roles: {}, extraInstructions: '' }, 'There is no role "zz" in this lineup'],
    [{ excludedRoleIds: ['p', 'i', 'r'], roles: {}, extraInstructions: '' }, 'At least one role must run'],
    [{ excludedRoleIds: [], roles: { zz: { model: 'opus' } }, extraInstructions: '' }, 'There is no role "zz" in this lineup'],
    [{ excludedRoleIds: [], roles: { i: { model: 'gpt-4' } }, extraInstructions: '' }, 'Implementer has an unknown model: "gpt-4"'],
    [{ excludedRoleIds: [], roles: { i: { effort: 'huge' } }, extraInstructions: '' }, 'Implementer has an unknown effort: "huge"'],
    [{ excludedRoleIds: [], roles: {}, extraInstructions: 'x'.repeat(10_001) }, 'Extra instructions must be at most 10000 characters'],
    [{ excludedRoleIds: 'p', roles: {}, extraInstructions: '' }, 'The roles left out are not valid'],
    [{ excludedRoleIds: [], roles: {}, extraInstructions: 3 }, 'Extra instructions must be text']
  ])('refuses %j', (input, message) => {
    expect(() => checkRunSettings(input as never, LINEUP)).toThrow(message)
  })
})
