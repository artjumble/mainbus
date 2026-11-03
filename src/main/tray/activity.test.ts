import { describe, expect, test } from 'vitest'
import { arrivals, countActivity, snapshotOf } from './activity'
import { ticket } from './fixtures'

describe('countActivity', () => {
  test('counts working agents, tickets in Needs you, and every open agent across workspaces', () => {
    const a = [ticket('t1', 'in_progress', 'working'), ticket('t2', 'in_progress', 'queued'), ticket('t3', 'needs_you', 'waiting_on_you')]
    const b = [ticket('t4', 'in_progress', 'working'), ticket('t5', 'review', 'handed_off'), ticket('t6', 'done', null)]
    expect(countActivity([a, b])).toEqual({ working: 2, needsYou: 1, openAgents: 4 })
  })

  test('a paused or failed agent is not open, and an empty board is all zeros', () => {
    expect(countActivity([[ticket('t1', 'needs_you', 'failed'), ticket('t2', 'in_progress', 'paused')]])).toEqual({
      working: 0,
      needsYou: 1,
      openAgents: 0
    })
    expect(countActivity([])).toEqual({ working: 0, needsYou: 0, openAgents: 0 })
  })
})

describe('arrivals', () => {
  test('the first snapshot only seeds: nothing arrives at launch', () => {
    expect(arrivals(null, [ticket('t1', 'needs_you')])).toEqual([])
  })

  test('a ticket that moves into Needs you or Review arrives, with its summary', () => {
    const prev = snapshotOf([ticket('t1', 'in_progress', 'working'), ticket('t2', 'in_progress', 'working')])
    const found = arrivals(prev, [ticket('t1', 'needs_you', 'waiting_on_you', { summary: 'Where?' }), ticket('t2', 'review')])
    expect(found.map((a) => [a.ticketId, a.column, a.summary])).toEqual([
      ['t1', 'needs_you', 'Where?'],
      ['t2', 'review', null]
    ])
  })

  test('a ticket already in the column, or one that moves elsewhere, is no arrival; a new ticket in Needs you is', () => {
    const prev = snapshotOf([ticket('t1', 'needs_you'), ticket('t2', 'needs_you')])
    expect(arrivals(prev, [ticket('t1', 'needs_you'), ticket('t2', 'in_progress'), ticket('t3', 'ready')])).toEqual([])
    expect(arrivals(prev, [ticket('t4', 'needs_you')]).map((a) => a.ticketId)).toEqual(['t4'])
  })
})
