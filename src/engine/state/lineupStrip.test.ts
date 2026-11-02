import { describe, expect, test } from 'vitest'
import type { AgentStatus, RoleStatus } from '../../shared/domain'
import type { EndReason } from '../store/runs'
import { lineupStrip, type StripInput } from './lineupStrip'

const roles = [
  { id: 'p', name: 'Planner' },
  { id: 'i', name: 'Implementer' },
  { id: 'r', name: 'Reviewer' }
]

function run(id: string, roleId: string, endReason: EndReason | null = null): StripInput['runs'][number] {
  return { id, roleId, endReason }
}

/** The strip as [name, status, active] rows. */
function strip(input: Partial<StripInput>): [string, RoleStatus, boolean][] {
  return lineupStrip({ roles, runs: [], latestRunId: null, agentStatus: null, ...input }).map((r) => [r.name, r.status, r.active])
}

describe('lineupStrip', () => {
  test('after a hand-back the reporter counts as handed off and the earlier role, working again, is active', () => {
    const runs = [run('a', 'p', 'handoff'), run('b', 'i', 'handoff'), run('c', 'r', 'handed_back'), run('d', 'i')]
    expect(strip({ runs, latestRunId: 'd', agentStatus: 'working' })).toEqual([
      ['Planner', 'handed_off', false],
      ['Implementer', 'working', true],
      ['Reviewer', 'handed_off', false]
    ])
  })

  test('before the first run every role is not started and none is active', () => {
    expect(strip({})).toEqual([
      ['Planner', 'not_started', false],
      ['Implementer', 'not_started', false],
      ['Reviewer', 'not_started', false]
    ])
  })

  test('mid-run: earlier roles handed off, the open one working, later ones not started', () => {
    const runs = [run('a', 'p', 'handoff'), run('b', 'i')]
    expect(strip({ runs, latestRunId: 'b', agentStatus: 'working' })).toEqual([
      ['Planner', 'handed_off', false],
      ['Implementer', 'working', true],
      ['Reviewer', 'not_started', false]
    ])
  })

  test.each<[AgentStatus | null, RoleStatus]>([
    ['working', 'working'],
    ['queued', 'working'],
    ['waiting_on_you', 'waiting_on_you'],
    ['paused', 'paused'],
    [null, 'paused']
  ])('the open role with the ticket %s is %s', (agentStatus, status) => {
    expect(strip({ runs: [run('a', 'p')], latestRunId: 'a', agentStatus })[0]).toEqual(['Planner', status, true])
  })

  test.each<[EndReason, RoleStatus]>([
    ['failed', 'failed'],
    ['stopped', 'stopped'],
    ['handoff', 'handed_off'],
    ['handed_back', 'handed_off']
  ])('a role whose run ended by %s is %s, and nothing is active', (endReason, status) => {
    const runs = [run('a', 'p', 'handoff'), run('b', 'i', endReason)]
    // The ticket's status (null after a stop) does not change an ended run's role.
    expect(strip({ runs, latestRunId: 'b', agentStatus: null })).toEqual([
      ['Planner', 'handed_off', false],
      ['Implementer', status, false],
      ['Reviewer', 'not_started', false]
    ])
  })

  test('when every role handed off, all are handed off', () => {
    const runs = [run('a', 'p', 'handoff'), run('b', 'i', 'handoff'), run('c', 'r', 'handoff')]
    expect(strip({ runs, latestRunId: 'c', agentStatus: 'handed_off' }).map(([, s, a]) => [s, a])).toEqual([
      ['handed_off', false],
      ['handed_off', false],
      ['handed_off', false]
    ])
  })

  test('only the roles of the run are shown: roles left unticked at start are absent', () => {
    const ticked = roles.filter((r) => r.id !== 'p')
    expect(strip({ roles: ticked, runs: [run('a', 'i')], latestRunId: 'a', agentStatus: 'working' })).toEqual([
      ['Implementer', 'working', true],
      ['Reviewer', 'not_started', false]
    ])
  })

  test('mid-handoff, with both runs open, only the latest is active', () => {
    const runs = [run('a', 'p'), run('b', 'i')]
    expect(strip({ runs, latestRunId: 'b', agentStatus: 'working' }).slice(0, 2)).toEqual([
      ['Planner', 'handed_off', false],
      ['Implementer', 'working', true]
    ])
  })
})

describe('replacements', () => {
  test('counts the role’s replaced agents, and the role still appears once', () => {
    const runs = [run('a', 'p', 'handoff'), run('b', 'i', 'replaced'), run('c', 'i', 'replaced'), run('d', 'i')]
    const lineup = lineupStrip({ roles, runs, latestRunId: 'd', agentStatus: 'working' })
    expect(lineup.map((r) => [r.name, r.replacements])).toEqual([
      ['Planner', 0],
      ['Implementer', 2],
      ['Reviewer', 0]
    ])
  })
})
