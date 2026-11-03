import type { EngineEvent } from '../../shared/api'
import { FakeClock } from '../holds/clock'
import type { Repos } from '../store'
import { FIXED_NOW } from '../store/testDb'
import type { TicketRunner } from './ticketRunner'
import { UsageGate, usageHooks } from './usageGate'

/** A usage gate on a fake clock, wired to a runner given to `attach` afterwards (the two need each other). */
export function testUsage(repos: Repos, emit: (e: EngineEvent) => void = () => {}, retryMs?: number) {
  const clock = new FakeClock(FIXED_NOW)
  let runner: TicketRunner | null = null
  const gate = new UsageGate({
    settings: repos.settings,
    clock,
    emit,
    ...(retryMs !== undefined ? { retryMs } : {}),
    runner: {
      pauseForUsageLimit: (id) => runner!.pauseForUsageLimit(id),
      releaseLimitPaused: () => runner!.releaseLimitPaused(),
      probe: () => runner!.probe(),
      limitPausedCount: () => runner!.limitPausedCount(),
      kickQueue: () => runner!.kickQueue()
    }
  })
  return {
    clock,
    gate,
    hooks: usageHooks(gate),
    attach(r: TicketRunner): void {
      runner = r
    }
  }
}

export type TestUsage = ReturnType<typeof testUsage>
