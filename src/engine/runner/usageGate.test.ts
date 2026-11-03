import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent } from '../../shared/api'
import type { UsageState } from '../../shared/domain'
import type { AgentEvent } from '../../shared/events'
import { FakeClock } from '../holds/clock'
import type { StoredUsageLimit } from '../store/settings'
import { UsageGate, USAGE_RETRY_MS } from './usageGate'

const START = new Date('2026-11-02T09:00:00.000Z')
const HOUR = 3_600_000
const secs = (ms: number): number => Math.floor(ms / 1000)

type RateLimit = Extract<AgentEvent, { kind: 'rate_limit' }>
const rejected = (resetsAtMs?: number): RateLimit => ({
  kind: 'rate_limit',
  status: 'rejected',
  ...(resetsAtMs === undefined ? {} : { resetsAt: secs(resetsAtMs) }),
  windows: {}
})
const window = (utilization: number, resetsAtMs: number, status = 'allowed'): RateLimit => ({
  kind: 'rate_limit',
  status,
  windows: { five_hour: { utilization, resetsAt: secs(resetsAtMs), status } }
})

let clock: FakeClock
let stored: StoredUsageLimit | null
let events: UsageState[]
let paused: number

function runner() {
  return {
    pauseForUsageLimit: vi.fn((_id: string | null) => {}),
    releaseLimitPaused: vi.fn(async () => {
      paused = 0
    }),
    probe: vi.fn(async () => true),
    limitPausedCount: vi.fn(async () => paused),
    kickQueue: vi.fn(() => {})
  }
}

function makeGate() {
  const r = runner()
  const gate = new UsageGate({
    settings: {
      usageLimit: async () => stored,
      setUsageLimit: async (v) => void (stored = v)
    },
    clock,
    emit: (e: EngineEvent) => {
      if (e.type === 'usage.changed') events.push(e.state)
    },
    runner: r
  })
  return { gate, r }
}

beforeEach(() => {
  clock = new FakeClock(START)
  stored = null
  events = []
  paused = 0
})

describe('UsageGate entering the limited state', () => {
  it('a rejected event with a reset time limits the app, pauses the agents, stores the state and tells the renderer', async () => {
    const { gate, r } = makeGate()
    paused = 2
    const reset = START.getTime() + HOUR
    gate.rateLimit(rejected(reset), 'run1')

    expect(r.pauseForUsageLimit).toHaveBeenCalledWith('run1')
    expect(gate.isLimited()).toBe(true)
    expect(gate.blocksStarts()).toBe(true)
    expect(gate.limitedUntil()).toBe(reset)
    expect(gate.pauseReason()).toMatch(/^Usage limit; resumes at \d\d:\d\d$/)
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ kind: 'limited', resetsAt: new Date(reset).toISOString(), retryAt: null, paused: 2 }))
    expect(stored).toEqual({ since: START.toISOString(), resetsAt: new Date(reset).toISOString() })
  })

  it('error text alone (no reset time) limits the app and schedules a try in 15 minutes', async () => {
    const { gate } = makeGate()
    gate.hit({ resetsAt: null }, null)
    expect(gate.limitedUntil()).toBe(START.getTime() + USAGE_RETRY_MS)
    expect(gate.pauseReason()).toMatch(/^Usage limit; trying again at \d\d:\d\d$/)
    await vi.waitFor(() => expect(stored).toEqual({ since: START.toISOString(), resetsAt: null }))
  })

  it('a reset time already past counts as unknown', () => {
    const { gate } = makeGate()
    gate.hit({ resetsAt: START.getTime() - 1000 }, 'run1')
    expect(gate.limitedUntil()).toBe(START.getTime() + USAGE_RETRY_MS)
  })

  it('a second hit while limited starts a new wait, keeping the newer known reset, and the old one when the new is unknown', () => {
    const { gate, r } = makeGate()
    gate.hit({ resetsAt: START.getTime() + HOUR }, 'a')
    gate.hit({ resetsAt: START.getTime() + 2 * HOUR }, 'b')
    expect(gate.limitedUntil()).toBe(START.getTime() + 2 * HOUR)
    gate.hit({ resetsAt: null }, 'c')
    expect(gate.limitedUntil()).toBe(START.getTime() + 2 * HOUR)
    expect(r.pauseForUsageLimit).toHaveBeenCalledTimes(3)
  })
})

describe('UsageGate leaving it', () => {
  it('at the reset, releases the paused agents in order and tells the renderer', async () => {
    const { gate, r } = makeGate()
    paused = 2
    gate.hit({ resetsAt: START.getTime() + HOUR }, 'a')
    await clock.advance(HOUR - 1)
    expect(r.releaseLimitPaused).not.toHaveBeenCalled()
    await clock.advance(1)

    expect(r.releaseLimitPaused).toHaveBeenCalledTimes(1)
    expect(gate.isLimited()).toBe(false)
    expect(gate.blocksStarts()).toBe(false)
    expect(stored).toBeNull()
    expect(events.at(-1)).toEqual({ kind: 'ok' })
  })

  it('with no known reset, tries one agent every 15 minutes and releases the rest when one gets through', async () => {
    const { gate, r } = makeGate()
    paused = 3
    gate.hit({ resetsAt: null }, 'a')
    await clock.advance(USAGE_RETRY_MS)
    expect(r.probe).toHaveBeenCalledTimes(1)
    expect(r.releaseLimitPaused).not.toHaveBeenCalled()
    await clock.advance(USAGE_RETRY_MS)
    expect(r.probe).toHaveBeenCalledTimes(2)

    gate.gotThrough()
    await vi.waitFor(() => expect(r.releaseLimitPaused).toHaveBeenCalledTimes(1))
    expect(gate.isLimited()).toBe(false)
    await clock.advance(USAGE_RETRY_MS)
    expect(r.probe).toHaveBeenCalledTimes(2)
  })

  it('a limit hit again by the probe starts a new wait of 15 minutes from then', async () => {
    const { gate, r } = makeGate()
    paused = 1
    gate.hit({ resetsAt: null }, 'a')
    await clock.advance(USAGE_RETRY_MS)
    gate.hit({ resetsAt: null }, 'probe')
    expect(gate.limitedUntil()).toBe(clock.now().getTime() + USAGE_RETRY_MS)
    await clock.advance(USAGE_RETRY_MS - 1)
    expect(r.probe).toHaveBeenCalledTimes(1)
    await clock.advance(1)
    expect(r.probe).toHaveBeenCalledTimes(2)
  })

  it('with no known reset and nothing left paused, the state just ends', async () => {
    const { gate, r } = makeGate()
    paused = 0
    gate.hit({ resetsAt: null }, null)
    await clock.advance(USAGE_RETRY_MS)
    expect(r.probe).not.toHaveBeenCalled()
    expect(gate.isLimited()).toBe(false)
  })

  it('Resume now ends it at once', async () => {
    const { gate, r } = makeGate()
    paused = 2
    gate.hit({ resetsAt: START.getTime() + HOUR }, 'a')
    await gate.resumeNow()
    expect(r.releaseLimitPaused).toHaveBeenCalledTimes(1)
    expect(gate.isLimited()).toBe(false)
    expect(stored).toBeNull()
    // The reset timer is gone.
    await clock.advance(2 * HOUR)
    expect(r.releaseLimitPaused).toHaveBeenCalledTimes(1)
  })
})

describe('UsageGate across a restart', () => {
  it('load blocks starts from the stored state, and start arms the reset that is still ahead', async () => {
    stored = { since: START.toISOString(), resetsAt: new Date(START.getTime() + HOUR).toISOString() }
    const { gate, r } = makeGate()
    await gate.load()
    expect(gate.blocksStarts()).toBe(true)
    await gate.start()
    expect(r.releaseLimitPaused).not.toHaveBeenCalled()
    await clock.advance(HOUR)
    expect(r.releaseLimitPaused).toHaveBeenCalledTimes(1)
    expect(stored).toBeNull()
  })

  it('a reset that passed while closed releases the agents at start', async () => {
    stored = { since: START.toISOString(), resetsAt: new Date(START.getTime() + HOUR).toISOString() }
    await clock.advance(2 * HOUR)
    const { gate, r } = makeGate()
    await gate.load()
    await gate.start()
    expect(r.releaseLimitPaused).toHaveBeenCalledTimes(1)
    expect(gate.isLimited()).toBe(false)
  })

  it('with no reset the first try comes 15 minutes after the limit began, or at once if that has passed', async () => {
    stored = { since: START.toISOString(), resetsAt: null }
    paused = 2
    const first = makeGate()
    await first.gate.load()
    await first.gate.start()
    await clock.advance(USAGE_RETRY_MS - 1)
    expect(first.r.probe).not.toHaveBeenCalled()
    await clock.advance(1)
    expect(first.r.probe).toHaveBeenCalledTimes(1)
    first.gate.dispose()

    await clock.advance(5 * HOUR)
    stored = { since: START.toISOString(), resetsAt: null }
    const late = makeGate()
    await late.gate.load()
    await late.gate.start()
    await clock.advance(0)
    expect(late.r.probe).toHaveBeenCalledTimes(1)
  })

  it('agents still marked paused with no state stored are released at start', async () => {
    paused = 2
    const { gate, r } = makeGate()
    await gate.load()
    await gate.start()
    expect(r.releaseLimitPaused).toHaveBeenCalledTimes(1)
  })
})

describe('UsageGate early warning', () => {
  it('holds new starts at 90% and clears when a later event shows less', async () => {
    const { gate, r } = makeGate()
    const reset = START.getTime() + HOUR
    gate.rateLimit(window(0.89, reset), 'a')
    expect(gate.blocksStarts()).toBe(false)
    gate.rateLimit(window(0.9, reset), 'a')
    expect(gate.blocksStarts()).toBe(true)
    expect(gate.isLimited()).toBe(false)
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ kind: 'warning', resetsAt: new Date(reset).toISOString() }))

    gate.rateLimit(window(0.5, reset), 'a')
    expect(gate.blocksStarts()).toBe(false)
    expect(r.kickQueue).toHaveBeenCalled()
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ kind: 'ok' }))
  })

  it('clears when the window resets', async () => {
    const { gate, r } = makeGate()
    gate.rateLimit(window(0.95, START.getTime() + HOUR), 'a')
    expect(gate.blocksStarts()).toBe(true)
    await clock.advance(HOUR)
    expect(gate.blocksStarts()).toBe(false)
    expect(r.kickQueue).toHaveBeenCalled()
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ kind: 'ok' }))
  })

  it('allowed_warning without a window blocks until the SDK says allowed, or its reset', async () => {
    const { gate } = makeGate()
    gate.rateLimit({ kind: 'rate_limit', status: 'allowed_warning', resetsAt: secs(START.getTime() + HOUR), windows: {} }, 'a')
    expect(gate.blocksStarts()).toBe(true)
    gate.rateLimit({ kind: 'rate_limit', status: 'allowed', windows: {} }, 'a')
    expect(gate.blocksStarts()).toBe(false)

    // With no reset time it expires on its own, so the gate can never hold every agent for good.
    gate.rateLimit({ kind: 'rate_limit', status: 'allowed_warning', windows: {} }, 'a')
    expect(gate.blocksStarts()).toBe(true)
    await clock.advance(USAGE_RETRY_MS)
    expect(gate.blocksStarts()).toBe(false)
  })

  it('stays while another window is still close', async () => {
    const { gate } = makeGate()
    gate.rateLimit(
      {
        kind: 'rate_limit',
        status: 'allowed_warning',
        windows: {
          five_hour: { utilization: 0.95, resetsAt: secs(START.getTime() + HOUR), status: 'allowed_warning' },
          seven_day: { utilization: 0.91, resetsAt: secs(START.getTime() + 2 * HOUR), status: 'allowed_warning' }
        }
      },
      'a'
    )
    gate.rateLimit(window(0.2, START.getTime() + HOUR), 'a')
    expect(gate.blocksStarts()).toBe(true)
    await clock.advance(2 * HOUR)
    expect(gate.blocksStarts()).toBe(false)
  })
})
