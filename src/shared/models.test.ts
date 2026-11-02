import { describe, expect, test } from 'vitest'
import { defaultFor, modelAllowed, resolveModelEffort } from './models'

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
