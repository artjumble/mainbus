import { afterEach, describe, expect, test } from 'vitest'
import {
  ALIAS_MODEL_OPTIONS,
  DEFAULT_MODELS,
  defaultFor,
  modelAllowed,
  modelLabel,
  modelOptions,
  OTHER_ROLE_DEFAULT,
  resolveModelEffort,
  roleModelOptions,
  setModelOptions
} from './models'
import type { SupportedModel } from './orchestratorModel'

describe('the default table', () => {
  test.each([
    ['Planner', 'opus', 'high'],
    ['Reviewer', 'opus', 'medium'],
    ['Implementer', 'sonnet', 'medium'],
    ['  planner ', 'opus', 'high'],
    ['REVIEWER', 'opus', 'medium'],
    ['Tester', 'sonnet', 'medium'],
    ['', 'sonnet', 'medium']
  ])('%j runs with %s at %s effort', (name, model, effort) => {
    expect(defaultFor(name)).toEqual({ model, effort })
  })
})

describe('resolveModelEffort', () => {
  const bare = { name: 'Planner', model: null, effort: null }

  test('with nothing chosen, the default table', () => {
    expect(resolveModelEffort(bare)).toEqual({ model: 'opus', effort: 'high', source: 'default' })
  })

  test("the orchestrator's proposal beats the default table", () => {
    expect(resolveModelEffort(bare, { proposed: { model: 'haiku', effort: 'low' } })).toEqual({
      model: 'haiku',
      effort: 'low',
      source: 'orchestrator'
    })
  })

  test("the role's own setting beats the orchestrator", () => {
    const role = { name: 'Planner', model: 'sonnet', effort: 'medium' as const }
    expect(resolveModelEffort(role, { proposed: { model: 'haiku', effort: 'low' } })).toEqual({
      model: 'sonnet',
      effort: 'medium',
      source: 'role'
    })
  })

  test("the user's choice beats everything", () => {
    const role = { name: 'Planner', model: 'sonnet', effort: 'medium' as const }
    expect(
      resolveModelEffort(role, { user: { model: 'opus', effort: 'max' }, proposed: { model: 'haiku', effort: 'low' } })
    ).toEqual({ model: 'opus', effort: 'max', source: 'user' })
  })

  test('model and effort resolve on their own', () => {
    const role = { name: 'Reviewer', model: 'sonnet', effort: null }
    expect(resolveModelEffort(role, { proposed: { effort: 'low' } })).toMatchObject({ model: 'sonnet', effort: 'low' })
    expect(resolveModelEffort(role, { user: { effort: 'high' } })).toMatchObject({ model: 'sonnet', effort: 'high' })
    expect(resolveModelEffort({ ...role, model: null }, { proposed: { effort: 'low' } })).toMatchObject({
      model: 'opus',
      effort: 'low'
    })
  })
})

test('a start may choose an offered model, or the role’s own whatever it is', () => {
  expect(modelAllowed({ model: null }, 'haiku')).toBe(true)
  expect(modelAllowed({ model: null }, 'claude-opus-5-5')).toBe(false)
  expect(modelAllowed({ model: 'claude-opus-5-5' }, 'claude-opus-5-5')).toBe(true)
})

// Shaped like the binary's list: the `fable` alias lags behind the newest Fable it lists by id.
const LISTED: SupportedModel[] = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  { value: 'claude-fable-5-2', resolvedModel: 'claude-fable-5-2', displayName: 'Fable 5.2' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5' },
  { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1' },
  { value: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8', displayName: 'Opus 4.8' }
]
const withoutFable = LISTED.filter((m) => !(m.resolvedModel ?? m.value).includes('fable'))

describe("the roles' models", () => {
  afterEach(() => setModelOptions([]))

  test('the latest Fable the binary lists, by id when its alias lags behind, then the Opus, Sonnet and Haiku aliases with their versions', () => {
    expect(roleModelOptions(LISTED)).toEqual([
      { value: 'claude-fable-5-2', label: 'Fable 5.2' },
      { value: 'opus', label: 'Opus 5.5' },
      { value: 'sonnet', label: 'Sonnet 5.5' },
      { value: 'haiku', label: 'Haiku 5.5' }
    ])
  })

  test("Fable's alias when it names the latest, and only an older Fable when that is all the binary lists", () => {
    const aliasLatest = LISTED.filter((m) => m.value !== 'claude-fable-5-2').map((m) => (m.value === 'fable' ? { ...m, resolvedModel: 'claude-fable-5-2' } : m))
    expect(roleModelOptions(aliasLatest)[0]).toEqual({ value: 'fable', label: 'Fable 5.2' })
    expect(roleModelOptions(LISTED.filter((m) => m.value !== 'claude-fable-5-2'))[0]).toEqual({ value: 'fable', label: 'Fable 5.1' })
  })

  test('without a Fable, it is left out and nothing else changes', () => {
    expect(roleModelOptions(withoutFable).map((o) => o.value)).toEqual(['opus', 'sonnet', 'haiku'])
    expect(roleModelOptions([])).toEqual(ALIAS_MODEL_OPTIONS)
  })

  test('until the list is read, and when it is empty, the aliases are offered', () => {
    expect(modelOptions()).toEqual(ALIAS_MODEL_OPTIONS)
    setModelOptions(roleModelOptions(LISTED))
    setModelOptions([])
    expect(modelOptions()).toEqual(ALIAS_MODEL_OPTIONS)
  })

  test('a start may choose Fable once the binary offers it, and not before', () => {
    expect(modelAllowed({ model: null }, 'claude-fable-5-2')).toBe(false)
    setModelOptions(roleModelOptions(LISTED))
    expect(modelAllowed({ model: null }, 'claude-fable-5-2')).toBe(true)
    for (const alias of ['opus', 'sonnet', 'haiku']) expect(modelAllowed({ model: null }, alias)).toBe(true)
    setModelOptions(roleModelOptions(withoutFable))
    expect(modelAllowed({ model: null }, 'claude-fable-5-2')).toBe(false)
  })

  test('labels show the version: the offered label, else read from a full id', () => {
    expect(modelLabel('opus')).toBe('Opus')
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1')
    expect(modelLabel('fable')).toBe('Fable')
    expect(modelLabel('something-else')).toBe('something-else')
    setModelOptions(roleModelOptions(LISTED))
    expect(modelLabel('claude-fable-5-2')).toBe('Fable 5.2')
    expect(modelLabel('opus')).toBe('Opus 5.5')
    expect(modelLabel('claude-haiku-5-5')).toBe('Haiku 5.5')
    expect(modelLabel('claude-opus-5')).toBe('Opus 5')
  })

  test('the default table is unchanged by what the binary offers', () => {
    setModelOptions(roleModelOptions(LISTED))
    expect(DEFAULT_MODELS).toEqual([
      { name: 'Planner', model: 'opus', effort: 'high' },
      { name: 'Reviewer', model: 'opus', effort: 'medium' },
      { name: 'Implementer', model: 'sonnet', effort: 'medium' }
    ])
    expect(OTHER_ROLE_DEFAULT).toEqual({ model: 'sonnet', effort: 'medium' })
  })
})
