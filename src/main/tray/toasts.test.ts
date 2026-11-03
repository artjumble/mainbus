import { describe, expect, test } from 'vitest'
import type { Arrival } from './activity'
import { ToastBatcher, type Timer } from './toasts'

const arrival = (n: number): Arrival => ({ workspaceId: 'w1', ticketId: `t${n}`, number: n, title: `T${n}`, column: 'needs_you', summary: null })

function setup(hidden = true) {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = []
  const timer: Timer = (fn, ms) => {
    const t = { fn, ms, cancelled: false }
    timers.push(t)
    return () => {
      t.cancelled = true
    }
  }
  const batches: Arrival[][] = []
  const state = { hidden }
  const batcher = new ToastBatcher({ timer, hidden: () => state.hidden, flush: (b) => batches.push(b), ms: 1500 })
  const fire = (): void => timers.filter((t) => !t.cancelled).forEach((t) => t.fn())
  return { batcher, batches, state, timers, fire }
}

describe('ToastBatcher', () => {
  test('arrivals within one window flush as a single batch', () => {
    const { batcher, batches, timers, fire } = setup()
    batcher.add([arrival(1)])
    batcher.add([arrival(2), arrival(3)])
    expect(timers).toHaveLength(1)
    expect(timers[0]!.ms).toBe(1500)
    expect(batches).toEqual([])
    fire()
    expect(batches.map((b) => b.map((a) => a.number))).toEqual([[1, 2, 3]])
  })

  test('nothing is kept while the window is visible and focused', () => {
    const { batcher, batches, state, timers, fire } = setup(false)
    batcher.add([arrival(1)])
    expect(timers).toHaveLength(0)
    state.hidden = true
    fire()
    expect(batches).toEqual([])
  })

  test('a later arrival starts a new window', () => {
    const { batcher, batches, fire } = setup()
    batcher.add([arrival(1)])
    fire()
    batcher.add([arrival(2)])
    fire()
    expect(batches).toHaveLength(2)
  })

  test('dispose drops what is waiting', () => {
    const { batcher, batches, fire } = setup()
    batcher.add([arrival(1)])
    batcher.dispose()
    fire()
    expect(batches).toEqual([])
  })
})
