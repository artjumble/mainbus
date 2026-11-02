import { describe, expect, test, vi } from 'vitest'
import { FakeClock } from './clock'

const START = new Date('2026-11-02T09:00:00.000Z')

describe('FakeClock', () => {
  test('moves only when advanced, and runs the timers that come due in time order', async () => {
    const clock = new FakeClock(START)
    const seen: string[] = []
    clock.setTimeout(() => void seen.push(`b@${clock.now().toISOString()}`), 2000)
    clock.setTimeout(() => void seen.push(`a@${clock.now().toISOString()}`), 1000)
    expect(clock.now()).toEqual(START)
    await clock.advance(1500)
    expect(seen).toEqual(['a@2026-11-02T09:00:01.000Z'])
    expect(clock.now().toISOString()).toBe('2026-11-02T09:00:01.500Z')
    await clock.advance(1000)
    expect(seen).toHaveLength(2)
    expect(clock.pending).toBe(0)
  })

  test('waits for an async timer, runs a timer it sets for a time inside the advance, and can cancel', async () => {
    const clock = new FakeClock(START)
    const fn = vi.fn()
    clock.setTimeout(async () => {
      await Promise.resolve()
      clock.setTimeout(fn, 500)
    }, 1000)
    const cancelled = clock.setTimeout(fn, 100)
    clock.clearTimeout(cancelled)
    await clock.advance(2000)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
