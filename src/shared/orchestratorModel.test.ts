import { describe, expect, test } from 'vitest'
import { FAKE_SUPPORTED_MODELS } from '../engine/runtime/fakeRuntime'
import { ALIAS_FALLBACK, latestOfEachFamily, orchestratorModelState } from './orchestratorModel'

describe('latestOfEachFamily', () => {
  test('the latest Fable, Opus and Sonnet by version, using the alias only when it names the latest', () => {
    expect(latestOfEachFamily(FAKE_SUPPORTED_MODELS)).toEqual([
      // The `fable` alias still names Fable 5.1, so Fable 5.2 is chosen by its id.
      { family: 'fable', model: 'claude-fable-5-2', label: 'Fable 5.2' },
      { family: 'opus', model: 'opus', label: 'Opus 5.5' },
      { family: 'sonnet', model: 'sonnet', label: 'Sonnet 5.5' }
    ])
  })

  test('reads versions from full ids, dated or not; a whole version has no minor; variants and other families are left out', () => {
    expect(
      latestOfEachFamily([
        { value: 'claude-opus-5', displayName: 'Opus 5' },
        { value: 'claude-opus-4-8-20260101', displayName: 'Opus 4.8' },
        { value: 'opus[1m]', resolvedModel: 'claude-opus-6-1[1m]', displayName: 'Opus 6.1 (1M)' },
        { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' },
        { value: 'claude-sonnet-5-10', displayName: 'Sonnet 5.10' },
        { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5' },
        { value: 'default', resolvedModel: 'claude-opus-5', displayName: 'Default' }
      ])
    ).toEqual([
      { family: 'opus', model: 'claude-opus-5', label: 'Opus 5' },
      { family: 'sonnet', model: 'claude-sonnet-5-10', label: 'Sonnet 5.10' }
    ])
  })

  test('a family the list lacks is not offered, and nothing usable offers nothing', () => {
    expect(latestOfEachFamily(FAKE_SUPPORTED_MODELS.filter((m) => !m.resolvedModel?.includes('fable'))).map((o) => o.label)).toEqual([
      'Opus 5.5',
      'Sonnet 5.5'
    ])
    expect(latestOfEachFamily([{ value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5' }])).toEqual([])
  })
})

describe('orchestratorModelState', () => {
  const offered = latestOfEachFamily(FAKE_SUPPORTED_MODELS)

  test('the saved choice when it is offered, with its effort and no notice', () => {
    expect(orchestratorModelState({ family: 'fable', effort: 'high' }, offered, true)).toEqual({
      options: offered,
      fromBinary: true,
      saved: 'fable',
      current: { family: 'fable', model: 'claude-fable-5-2', label: 'Fable 5.2' },
      effort: 'high',
      notice: null
    })
  })

  test('a saved choice that is no longer offered falls back to Opus, with a notice', () => {
    const state = orchestratorModelState({ family: 'fable', effort: 'low' }, offered.filter((o) => o.family !== 'fable'), true)
    expect(state.current).toEqual({ family: 'opus', model: 'opus', label: 'Opus 5.5' })
    expect(state.effort).toBe('low')
    expect(state.notice).toBe("Fable isn't offered by your claude, so the orchestrator uses Opus 5.5.")
  })

  test('without Opus either, the first one offered', () => {
    const state = orchestratorModelState({ family: 'fable', effort: 'medium' }, offered.filter((o) => o.family === 'sonnet'), true)
    expect(state.current.label).toBe('Sonnet 5.5')
  })

  test("with the aliases standing in, the notice says the list couldn't be read", () => {
    const state = orchestratorModelState({ family: 'fable', effort: 'medium' }, ALIAS_FALLBACK, false)
    expect(state.options).toEqual(ALIAS_FALLBACK)
    expect(state.current).toEqual({ family: 'opus', model: 'opus', label: 'Opus' })
    expect(state.notice).toBe("Fable isn't offered by your claude (its model list could not be read), so the orchestrator uses Opus.")
    expect(orchestratorModelState({ family: 'sonnet', effort: 'medium' }, [], false).current.model).toBe('sonnet')
  })
})
