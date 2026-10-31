import { describe, expect, test } from 'vitest'
import { testRepoFromEnv } from './testHooks'

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
