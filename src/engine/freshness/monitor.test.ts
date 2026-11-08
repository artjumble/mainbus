import { describe, expect, it, vi } from 'vitest'
import type { EngineEvent } from '../../shared/api'
import type { Ticket, Workspace } from '../../shared/domain'
import { FakeClock } from '../holds/clock'
import type { BranchFreshnessChecker } from '../git/freshness'
import { FreshnessMonitor } from './monitor'

const WS = { id: 'w1', repoPath: '/r', baseBranch: 'main' } as Workspace

function setup(tickets: Partial<Ticket>[]) {
  const clock = new FakeClock(new Date('2026-11-07T10:00:00Z'))
  const emitted: EngineEvent[] = []
  let behind = 2
  const checker = {
    newestBase: vi.fn(async () => ({ ref: 'origin/main', sha: 'abc', notice: null, fetchError: null })),
    check: vi.fn(async (_repo: string, branch: string) => {
      if (branch === 'gone') throw new Error('no such branch')
      return { behind, conflicts: behind > 1 ? ['a.sql'] : [] }
    })
  }
  const all = tickets as Ticket[]
  const monitor = new FreshnessMonitor({
    repos: { workspaces: { get: async (id: string) => (id === 'w1' ? WS : null), list: async () => [WS] }, tickets: { list: async () => all } } as never,
    checker: checker as unknown as BranchFreshnessChecker,
    now: () => clock.now(),
    emit: (e) => emitted.push(e),
    timer: clock,
    intervalMs: 1000
  })
  return { monitor, checker, clock, emitted, setBehind: (n: number) => (behind = n) }
}

describe('FreshnessMonitor', () => {
  it('measures open tickets with a branch, and skips Done ones and ones with no branch', async () => {
    const { monitor, checker } = setup([
      { id: 'open', manualColumn: 'ready', branch: 'b1' },
      { id: 'done', manualColumn: 'done', branch: 'b2' },
      { id: 'none', manualColumn: 'ready', branch: null }
    ])
    await monitor.refresh('w1')
    expect(checker.check).toHaveBeenCalledTimes(1)
    expect(monitor.statusOf('open')).toMatchObject({ baseBranch: 'main', base: 'origin/main', behind: 2, conflicts: ['a.sql'], fetchError: null })
    expect(monitor.statusOf('done')).toBeNull()
    expect(monitor.statusOf('none')).toBeNull()
    expect(checker.newestBase).toHaveBeenCalledWith(WS, { fetch: true })
  })

  it('fetches once per workspace, and not at all when asked not to', async () => {
    const { monitor, checker } = setup([
      { id: 'a', manualColumn: 'ready', branch: 'b1' },
      { id: 'b', manualColumn: 'ready', branch: 'b2' }
    ])
    await monitor.refresh('w1', { fetch: false })
    expect(checker.newestBase).toHaveBeenCalledTimes(1)
    expect(checker.newestBase).toHaveBeenCalledWith(WS, { fetch: false })
  })

  it('says the board changed only when an answer did', async () => {
    const { monitor, emitted, setBehind } = setup([{ id: 'open', manualColumn: 'ready', branch: 'b1' }])
    await monitor.refresh('w1')
    expect(emitted).toEqual([{ type: 'board.changed', workspaceId: 'w1' }])
    await monitor.refresh('w1')
    expect(emitted).toHaveLength(1)
    setBehind(0)
    await monitor.refresh('w1')
    expect(emitted).toHaveLength(2)
    expect(monitor.statusOf('open')).toMatchObject({ behind: 0, conflicts: [] })
  })

  it('shows nothing for a branch git cannot answer for, and forgets a ticket that moved to Done', async () => {
    const tickets: Partial<Ticket>[] = [
      { id: 'lost', manualColumn: 'ready', branch: 'gone' },
      { id: 'open', manualColumn: 'ready', branch: 'b1' }
    ]
    const { monitor } = setup(tickets)
    await monitor.refresh('w1')
    expect(monitor.statusOf('lost')).toBeNull()
    expect(monitor.statusOf('open')).not.toBeNull()
    tickets[1]!.manualColumn = 'done'
    await monitor.refresh('w1')
    expect(monitor.statusOf('open')).toBeNull()
  })

  it('measures again at each interval until disposed', async () => {
    const { monitor, checker, clock } = setup([{ id: 'open', manualColumn: 'ready', branch: 'b1' }])
    monitor.start()
    await clock.advance(1000)
    expect(checker.check).toHaveBeenCalledTimes(1)
    await clock.advance(1000)
    expect(checker.check).toHaveBeenCalledTimes(2)
    monitor.dispose()
    await clock.advance(5000)
    expect(checker.check).toHaveBeenCalledTimes(2)
  })
})
