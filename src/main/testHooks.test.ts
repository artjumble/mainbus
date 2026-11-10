import { describe, expect, test } from 'vitest'
import path from 'node:path'
import {
  launchMaximizedFromEnv,
  testClockStartFromEnv,
  testReposFromEnv as testRepoFromEnv,
  trayTestHookFromEnv,
  voiceFakeFromEnv
} from './testHooks'

const test_env = { MAINBUS_HOME: '/tmp/h', MAINBUS_RUNTIME: 'fake:e2e/script.json', MAINBUS_TEST_REPO: '/tmp/repo' }

describe('testReposFromEnv', () => {
  test('is the repo when a test home and a fake runtime are set', () => {
    expect(testRepoFromEnv(test_env)).toEqual(['/tmp/repo'])
  })

  test('lists several folders split on the path delimiter, dropping empty parts', () => {
    const list = ['/tmp/a', '/tmp/b'].join(path.delimiter)
    expect(testRepoFromEnv({ ...test_env, MAINBUS_TEST_REPO: `${list}${path.delimiter}` })).toEqual(['/tmp/a', '/tmp/b'])
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
    expect(testRepoFromEnv({ ...test_env, MAINBUS_TEST_REPO: path.delimiter })).toBeNull()
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

describe('launchMaximizedFromEnv', () => {
  test('is on for a normal launch, even with a stray MAINBUS_HOME or runtime', () => {
    expect(launchMaximizedFromEnv({})).toBe(true)
    expect(launchMaximizedFromEnv({ ...test_env, MAINBUS_HOME: undefined })).toBe(true)
    expect(launchMaximizedFromEnv({ ...test_env, MAINBUS_RUNTIME: 'sdk' })).toBe(true)
  })

  test('is off in a scripted test run unless the test asks for it', () => {
    expect(launchMaximizedFromEnv(test_env)).toBe(false)
    expect(launchMaximizedFromEnv({ ...test_env, MAINBUS_TEST_MAXIMIZED: '1' })).toBe(true)
  })
})

describe('voiceFakeFromEnv', () => {
  const env = { ...test_env, MAINBUS_TEST_VOICE: 'fake' }

  test('is on with a test home, a fake runtime and MAINBUS_TEST_VOICE=fake', () => {
    expect(voiceFakeFromEnv(env)).toBe(true)
  })

  test('is off without the variable, with another value, without MAINBUS_HOME or without a fake runtime', () => {
    expect(voiceFakeFromEnv(test_env)).toBe(false)
    expect(voiceFakeFromEnv({ ...env, MAINBUS_TEST_VOICE: 'real' })).toBe(false)
    expect(voiceFakeFromEnv({ ...env, MAINBUS_HOME: undefined })).toBe(false)
    expect(voiceFakeFromEnv({ ...env, MAINBUS_RUNTIME: undefined })).toBe(false)
  })
})
