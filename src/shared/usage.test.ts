import { describe, expect, it } from 'vitest'
import type { UsageState } from './domain'
import { usageBannerText, usagePauseReason } from './usage'
import { clockTime } from './waiting'

const at = '2026-11-02T14:00:00.000Z'
const t = clockTime(at)

describe('usage text', () => {
  it('words the pause reason with the reset time, or the retry time when the reset is unknown', () => {
    expect(usagePauseReason({ kind: 'limited', resetsAt: at, retryAt: null, paused: 2 })).toBe(`Usage limit; resumes at ${t}`)
    expect(usagePauseReason({ kind: 'limited', resetsAt: null, retryAt: at, paused: 2 })).toBe(`Usage limit; trying again at ${t}`)
  })

  it('words the banner for both states, with singular and plural agents', () => {
    expect(usageBannerText({ kind: 'limited', resetsAt: at, retryAt: null, paused: 3 })).toBe(`Usage limit reached. 3 agents paused; resuming at ${t}.`)
    expect(usageBannerText({ kind: 'limited', resetsAt: at, retryAt: null, paused: 1 })).toBe(`Usage limit reached. 1 agent paused; resuming at ${t}.`)
    expect(usageBannerText({ kind: 'limited', resetsAt: null, retryAt: at, paused: 2 })).toBe(`Usage limit reached. 2 agents paused; trying again at ${t}.`)
    expect(usageBannerText({ kind: 'warning', resetsAt: at })).toBe(`Close to the usage limit: new agents wait until it resets at ${t}.`)
    expect(usageBannerText({ kind: 'ok' } as UsageState)).toBe('')
  })
})
