import { describe, expect, test, vi } from 'vitest'
import type { Hold, Ticket, Workspace } from '../../shared/domain'
import type { HoldPayload } from '../../shared/proposals'
import { hold } from './hold'
import { ProposalInvalid, type ExecContext } from './kind'

const NOW = new Date('2026-11-02T09:00:00.000Z')
const TOMORROW = '2026-11-03T09:00:00.000Z'
const ws = { id: 'ws1' } as Workspace
const TICKET = { id: 't12', number: 12, title: 'Rate-limit login', manualColumn: 'ready' } as Ticket
const turn = { userMessage: 'Hold #12', workspaceId: 'ws1' }

function ctx(over: { open?: Workspace | null; ticket?: Ticket | null } = {}) {
  const c = {
    workspace: async () => (over.open === undefined ? ws : over.open),
    createTickets: async () => [],
    lineup: async () => [],
    ticketByNumber: async (_w: string, n: number) => (n === 12 ? (over.ticket === undefined ? TICKET : over.ticket) : null),
    whyNotStartable: async () => null,
    startTicket: async () => {},
    activeRole: async () => null,
    pauseTicket: async () => {},
    stopTicket: async () => {},
    skipTicket: async () => {},
    now: () => NOW,
    holdTicket: vi.fn(async (_id: string, opts: { until?: string; reason?: string }) => ({ until: opts.until ?? null }) as Hold),
    decision: async () => null,
    openStuckEpisode: async () => null,
    redirectTicket: async () => {},
    answerDecision: async () => {}
  }
  return c satisfies ExecContext
}

const propose = (input: unknown, c: ExecContext = ctx()) => Promise.resolve(hold.propose(input, turn, c))

describe('hold: propose', () => {
  test('stores the ticket, the date and the reason', async () => {
    expect(await propose({ ticket: 12, until: TOMORROW, reason: 'Waiting for the API' })).toEqual({
      ticketId: 't12',
      number: 12,
      title: 'Rate-limit login',
      until: TOMORROW,
      reason: 'Waiting for the API'
    })
  })

  test('a hold with no date has until null', async () => {
    expect(await propose({ ticket: 12, reason: 'Wait' })).toMatchObject({ until: null })
  })

  test('refuses what is wrong, naming the field', async () => {
    await expect(propose({ ticket: 12 })).rejects.toThrow(/^reason: /)
    await expect(propose({ ticket: 12, reason: '  ' })).rejects.toThrow(/^reason: /)
    await expect(propose({ ticket: 99, reason: 'x' })).rejects.toThrow('ticket: there is no ticket #99')
    await expect(propose({ ticket: 12, reason: 'x', until: 'soon' })).rejects.toThrow('until: The date is not a valid date')
    await expect(propose({ ticket: 12, reason: 'x', until: '2026-11-01T00:00:00.000Z' })).rejects.toThrow('until: The date has already passed')
    await expect(propose({ ticket: 12, reason: 'x', extra: 1 })).rejects.toThrow('Unknown field: extra')
    await expect(propose({ ticket: 12, reason: 'x' }, ctx({ ticket: { ...TICKET, manualColumn: 'done' } }))).rejects.toThrow(ProposalInvalid)
  })
})

describe('hold: override', () => {
  const stored: HoldPayload = { ticketId: 't12', number: 12, title: 'T', until: TOMORROW, reason: 'Wait' }

  test('changes the date, or clears it, and keeps the rest', () => {
    expect(hold.override!(stored, { until: '2026-11-10T00:00:00.000Z' }, NOW)).toEqual({ ...stored, until: '2026-11-10T00:00:00.000Z' })
    expect(hold.override!(stored, { until: null }, NOW)).toEqual({ ...stored, until: null })
  })

  test('validates like a proposal', () => {
    expect(() => hold.override!(stored, { until: '2026-11-01T00:00:00.000Z' }, NOW)).toThrow('until: The date has already passed')
    expect(() => hold.override!(stored, {}, NOW)).toThrow(ProposalInvalid)
    expect(() => hold.override!(stored, { until: null, reason: 'Other' }, NOW)).toThrow('Unknown field: reason')
  })
})

describe('hold: execute and outcome', () => {
  const payload: HoldPayload = { ticketId: 't12', number: 12, title: 'Rate-limit login', until: TOMORROW, reason: 'Wait' }
  const target = { workspaceId: 'ws1', proposalId: 'p1' }

  test('holds the ticket with the date and reason', async () => {
    const c = ctx()
    expect(await hold.execute(payload, target, c)).toEqual({ ticketId: 't12', number: 12, title: 'Rate-limit login', until: TOMORROW })
    expect(c.holdTicket).toHaveBeenCalledWith('t12', { until: TOMORROW, reason: 'Wait' })
  })

  test('holds with no date when the payload has none', async () => {
    const c = ctx()
    await hold.execute({ ...payload, until: null }, target, c)
    expect(c.holdTicket).toHaveBeenCalledWith('t12', { reason: 'Wait' })
  })

  test('fails when the workspace or the ticket is gone', async () => {
    await expect(hold.execute(payload, target, ctx({ open: null }))).rejects.toThrow('no longer open')
    await expect(hold.execute(payload, target, ctx({ ticket: null }))).rejects.toThrow('no longer exists')
  })

  test('tells the orchestrator what was held', () => {
    expect(hold.outcome({ ticketId: 't12', number: 12, title: 'Login', until: '2026-11-03T09:00:00.000Z' })).toBe('Held #12 "Login" until 2026-11-03.')
    expect(hold.outcome({ ticketId: 't12', number: 12, title: 'Login', until: null })).toBe(
      'Held #12 "Login" with no date; it stays held until the user releases it.'
    )
  })
})
