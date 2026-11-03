import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asOwnChange, isOwnChange, OWN_CHANGE_GRACE_MS, resetOwnChanges } from './ownChanges'

describe('asOwnChange', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetOwnChanges()
  })
  afterEach(() => vi.useRealTimers())

  it('is own while the command runs and for the grace after, then not', async () => {
    let finish: () => void = () => {}
    const run = asOwnChange('t1', () => new Promise<void>((r) => (finish = r)))
    expect(isOwnChange('t1')).toBe(true)
    finish()
    await run
    expect(isOwnChange('t1')).toBe(true)
    vi.advanceTimersByTime(OWN_CHANGE_GRACE_MS + 1)
    expect(isOwnChange('t1')).toBe(false)
  })

  it('stays own after a failure, and only for that ticket', async () => {
    await expect(asOwnChange('t1', () => Promise.reject(new Error('no')))).rejects.toThrow('no')
    expect(isOwnChange('t1')).toBe(true)
    expect(isOwnChange('t2')).toBe(false)
  })

  it('handles overlapping commands', async () => {
    let a: () => void = () => {}
    let b: () => void = () => {}
    const pa = asOwnChange('t1', () => new Promise<void>((r) => (a = r)))
    const pb = asOwnChange('t1', () => new Promise<void>((r) => (b = r)))
    a()
    await pa
    vi.advanceTimersByTime(OWN_CHANGE_GRACE_MS + 1)
    expect(isOwnChange('t1')).toBe(true)
    b()
    await pb
  })
})
