import { beforeEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../holds/clock'
import type { Wake } from '../store/wakes'
import { WAKE_DEBOUNCE_MS, WakeScheduler } from './wakes'

const START = new Date('2026-11-02T09:00:00.000Z')
const row = (n: number): Wake => ({ id: `w${n}`, workspaceId: 'ws', kind: 'failure', ref: `r${n}`, createdAt: START.toISOString(), presentedAt: null })

let clock: FakeClock
let pending: Wake[]
let woken: Wake[][]
let busy: boolean
let limitedUntil: number | null
let canWake: boolean
let scheduler: WakeScheduler

beforeEach(() => {
  clock = new FakeClock(START)
  pending = []
  woken = []
  busy = false
  limitedUntil = null
  canWake = true
  scheduler = new WakeScheduler({
    repo: { pending: async () => pending },
    clock,
    wake: async (rows) => {
      woken.push(rows)
    },
    busy: () => busy,
    usageLimitedUntil: () => limitedUntil,
    canWake: async () => canWake
  })
})

describe('the wake scheduler', () => {
  it('batches rows that arrive within the debounce into one turn, started after the debounce', async () => {
    await scheduler.start()
    pending = [row(1)]
    scheduler.added()
    await clock.advance(2000)
    pending = [row(1), row(2), row(3)]
    scheduler.added()
    await clock.advance(WAKE_DEBOUNCE_MS - 2001)
    expect(woken).toEqual([])
    await clock.advance(1)
    expect(woken).toEqual([[row(1), row(2), row(3)]])
    expect(clock.pending).toBe(0)
  })

  it('sets no timer at launch when nothing is pending, and starts nothing for a row that is gone', async () => {
    await scheduler.start()
    expect(clock.pending).toBe(0)
    scheduler.added()
    await clock.advance(WAKE_DEBOUNCE_MS)
    expect(woken).toEqual([])
  })

  it('presents rows left over from the last run at launch', async () => {
    pending = [row(1)]
    await scheduler.start()
    await clock.advance(WAKE_DEBOUNCE_MS)
    expect(woken).toHaveLength(1)
  })

  it('does not start before start(): rows added while launching wait for it', async () => {
    pending = [row(1)]
    scheduler.added()
    expect(clock.pending).toBe(0)
    await scheduler.start()
    expect(clock.pending).toBe(1)
  })

  it('never starts a turn while one runs, and gives rows that arrived meanwhile the next turn', async () => {
    await scheduler.start()
    pending = [row(1)]
    scheduler.added()
    await clock.advance(WAKE_DEBOUNCE_MS)
    expect(woken).toHaveLength(1)

    // The turn is running; a row arrives and its timer comes due, but nothing starts.
    busy = true
    pending = [row(1), row(2)]
    scheduler.added()
    await clock.advance(60_000)
    expect(woken).toHaveLength(1)

    // The turn ended well: the rows still pending get their turn after the debounce.
    busy = false
    pending = [row(2)]
    await scheduler.turnEnded(true)
    expect(clock.pending).toBe(1)
    await clock.advance(WAKE_DEBOUNCE_MS)
    expect(woken).toEqual([[row(1)], [row(2)]])
  })

  it('keeps five seconds between the starts of two turns', async () => {
    await scheduler.start()
    pending = [row(1)]
    scheduler.added()
    await clock.advance(WAKE_DEBOUNCE_MS)
    // A row comes a second after the start: it waits until five seconds after the last start, no sooner.
    await clock.advance(1000)
    pending = [row(2)]
    scheduler.added()
    await clock.advance(WAKE_DEBOUNCE_MS - 1)
    expect(woken).toHaveLength(1)
    await clock.advance(1)
    expect(woken).toHaveLength(2)
  })

  it('does not retry after a failed turn by itself, but takes a new row, a good turn or the next launch', async () => {
    await scheduler.start()
    pending = [row(1)]
    scheduler.added()
    await clock.advance(WAKE_DEBOUNCE_MS)
    await scheduler.turnEnded(false)
    await clock.advance(10 * 60_000)
    expect(woken).toHaveLength(1)
    expect(clock.pending).toBe(0)

    scheduler.added()
    await clock.advance(WAKE_DEBOUNCE_MS)
    expect(woken).toHaveLength(2)

    await scheduler.turnEnded(false)
    await scheduler.turnEnded(true)
    await clock.advance(WAKE_DEBOUNCE_MS)
    expect(woken).toHaveLength(3)
  })

  it('waits for a usage limit to reset', async () => {
    limitedUntil = START.getTime() + 15 * 60_000
    await scheduler.start()
    pending = [row(1)]
    scheduler.added()
    await clock.advance(14 * 60_000)
    expect(woken).toEqual([])
    await clock.advance(60_000)
    expect(woken).toHaveLength(1)
  })

  it('limitLifted gives rows that waited for the reset their turn without waiting for it', async () => {
    limitedUntil = START.getTime() + 60 * 60_000
    await scheduler.start()
    pending = [row(1)]
    scheduler.added()
    await clock.advance(30 * 60_000)
    expect(woken).toEqual([])

    // Resume now: the limit is gone before its reset time.
    limitedUntil = null
    await scheduler.limitLifted()
    await clock.advance(WAKE_DEBOUNCE_MS)
    expect(woken).toHaveLength(1)
  })

  it('leaves the rows pending while no turn can be started', async () => {
    canWake = false
    await scheduler.start()
    pending = [row(1)]
    scheduler.added()
    await clock.advance(WAKE_DEBOUNCE_MS)
    expect(woken).toEqual([])
  })

  it('clears its timer on dispose', async () => {
    pending = [row(1)]
    await scheduler.start()
    expect(clock.pending).toBe(1)
    scheduler.dispose()
    expect(clock.pending).toBe(0)
    scheduler.added()
    expect(clock.pending).toBe(0)
  })
})
