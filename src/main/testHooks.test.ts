import { describe, expect, test } from 'vitest'
import { testClockStartFromEnv, testRepoFromEnv, trayTestHookFromEnv } from './testHooks'

const test_env = { MAINBUS_HOME: '/tmp/h', MAINBUS_RUNTIME: 'fake:e2e/script.json', MAINBUS_TEST_REPO: '/tmp/repo' }

describe('testRepoFromEnv', () => {
  test('is the repo when a test home and a fake runtime are set', () => {
    expect(testRepoFromEnv(test_env)).toBe('/tmp/repo')
  })

  test('is ignored without MAINBUS_HOME, so a stray variable cannot skip the folder dialog', () => {
    expect(testRepoFromEnv({ ...test_env, MAINBUS_HOME: undefined })).toBeNull()
  })

  test('is ignored unless the runtime is a fake one', () => {
    expect(testRepoFromEnv({ ...test_env, MAINBUS_RUNTIME: undefined })).toBeNull()
    expect(testRepoFromEnv({ ...test_env, MAINBUS_RUNTIME: 'sdk' })).toBeNull()
  })

  test('is null when unset or empty', () => {
    expect(testRepoFromEnv({ ...test_env, MAINBUS_TEST_REPO: undefined })).toBeNull()
    expect(testRepoFromEnv({ ...test_env, MAINBUS_TEST_REPO: '' })).toBeNull()
  })
})

describe('testClockStartFromEnv', () => {
  const env = { ...test_env, MAINBUS_FAKE_CLOCK: '2026-11-02T09:00:00.000Z' }
  const now = new Date('2026-12-25T00:00:00.000Z')

  test('is the time given, or now', () => {
    expect(testClockStartFromEnv(env, now)).toEqual(new Date('2026-11-02T09:00:00.000Z'))
    expect(testClockStartFromEnv({ ...env, MAINBUS_FAKE_CLOCK: 'now' }, now)).toEqual(now)
  })

  test('is ignored without a test home or a fake runtime, so a stray variable cannot stop the clock', () => {
    expect(testClockStartFromEnv({ ...env, MAINBUS_HOME: undefined }, now)).toBeNull()
    expect(testClockStartFromEnv({ ...env, MAINBUS_RUNTIME: 'sdk' }, now)).toBeNull()
  })

  test('is null when unset, empty or not a time', () => {
    expect(testClockStartFromEnv(test_env, now)).toBeNull()
    expect(testClockStartFromEnv({ ...env, MAINBUS_FAKE_CLOCK: '' }, now)).toBeNull()
    expect(testClockStartFromEnv({ ...env, MAINBUS_FAKE_CLOCK: 'later' }, now)).toBeNull()
  })
})

describe('trayTestHookFromEnv', () => {
  test('is on with a test home and a fake runtime', () => {
    expect(trayTestHookFromEnv(test_env)).toBe(true)
  })

  test('is off without MAINBUS_HOME or a fake runtime, so a normal install keeps real toasts', () => {
    expect(trayTestHookFromEnv({ ...test_env, MAINBUS_HOME: undefined })).toBe(false)
    expect(trayTestHookFromEnv({ ...test_env, MAINBUS_RUNTIME: undefined })).toBe(false)
    expect(trayTestHookFromEnv({ ...test_env, MAINBUS_RUNTIME: 'sdk' })).toBe(false)
  })
})
