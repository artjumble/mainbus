import { describe, expect, it } from 'vitest'
import type { BoardTicket } from '../../shared/api'
import type { TicketState } from '../../shared/domain'
import { railCounts } from './railCounts'

function ticket(state: Partial<TicketState>): BoardTicket {
  return {
    state: { column: 'in_progress', phase: 'implementing', agentStatus: null, summary: null, canContinue: false, pausedByUser: false, deferredUntil: null, ...state }
  } as BoardTicket
}

describe('railCounts', () => {
  it('counts the tickets in Needs you', () => {
    const tickets = [ticket({ column: 'needs_you' }), ticket({ column: 'needs_you' }), ticket({ column: 'ready' })]
    expect(railCounts(tickets, false)).toMatchObject({ active: false, needsYou: 2 })
  })

  it('is active while an agent works or waits for a slot', () => {
    expect(railCounts([ticket({ agentStatus: 'working' })], false).active).toBe(true)
    expect(railCounts([ticket({ agentStatus: 'queued' })], false).active).toBe(true)
    expect(railCounts([ticket({ agentStatus: 'waiting_on_you', column: 'needs_you' })], false).active).toBe(false)
    expect(railCounts([], false).active).toBe(false)
  })

  it('counts an agent that only looks paused as active while restart recovery runs', () => {
    const paused = ticket({ agentStatus: 'paused', canContinue: true })
    expect(railCounts([paused], false).active).toBe(false)
    expect(railCounts([paused], true).active).toBe(true)
  })

  it('never counts an agent the user or a usage limit paused', () => {
    expect(railCounts([ticket({ agentStatus: 'paused', canContinue: true, pausedByUser: true })], true).active).toBe(false)
    expect(railCounts([ticket({ agentStatus: 'paused', canContinue: true, pausedByLimit: true })], true).active).toBe(false)
  })

  it('counts agents working, waiting on you, and idle (paused or queued)', () => {
    const tickets = [
      ticket({ agentStatus: 'working' }),
      ticket({ agentStatus: 'working' }),
      ticket({ agentStatus: 'waiting_on_you', column: 'needs_you' }),
      ticket({ agentStatus: 'paused' }),
      ticket({ agentStatus: 'queued' }),
      ticket({ agentStatus: null, column: 'backlog' })
    ]
    expect(railCounts(tickets, false)).toMatchObject({ working: 2, waiting: 1, idle: 2 })
  })
})
