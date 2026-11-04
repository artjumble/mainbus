import { describe, expect, test, vi } from 'vitest'
import type { Ticket, Workspace } from '../../shared/domain'
import type { PromotePayload } from '../../shared/proposals'
import { ProposalInvalid, type ExecContext } from './kind'
import { promote } from './promote'

const ws = { id: 'ws1' } as Workspace
const TICKET = { id: 't4', number: 4, title: 'Why is login slow', kind: 'investigate', report: '# R' } as Ticket
const turn = { userMessage: 'Promote #4', workspaceId: 'ws1' }

function ctx(over: { open?: Workspace | null; ticket?: Ticket | null; why?: string | null; drafted?: boolean } = {}) {
  const c = {
    orchestratorFolder: '/home/orchestrator',
    workspace: async () => (over.open === undefined ? ws : over.open),
    createTickets: async () => [],
    lineup: async () => [],
    ticketByNumber: async (_w: string, n: number) => (n === 4 ? (over.ticket === undefined ? TICKET : over.ticket) : null),
    whyNotStartable: async () => null,
    startTicket: async () => {},
    activeRole: async () => null,
    pauseTicket: async () => {},
    stopTicket: async () => {},
    skipTicket: async () => {},
    now: () => new Date(),
    holdTicket: async () => {
      throw new Error('not expected')
    },
    decision: async () => null,
    openStuckEpisode: async () => null,
    redirectTicket: async () => {},
    replaceTicket: async () => {},
    whyNotPromotable: vi.fn(async () => (over.why === undefined ? null : over.why)),
    draftPromotionSpec: vi.fn(async () => ({ spec: 'Drafted spec', drafted: over.drafted ?? true })),
    promoteTicket: vi.fn(async (_id: string, f: { title: string; spec: string }) => ({ id: 't7', number: 7, title: f.title }) as Ticket),
    answerDecision: async () => {}
  }
  return c satisfies ExecContext
}

const propose = (input: unknown, c: ExecContext = ctx()) => Promise.resolve(promote.propose(input, turn, c))

describe('promote: propose', () => {
  test('defaults the title to the ticket and drafts the spec when none is given', async () => {
    const c = ctx()
    expect(await propose({ ticket: 4 }, c)).toEqual({
      ticketId: 't4',
      number: 4,
      fromTitle: 'Why is login slow',
      title: 'Why is login slow',
      spec: 'Drafted spec',
      specSource: 'summary'
    })
    expect(c.draftPromotionSpec).toHaveBeenCalledWith(TICKET)
  })

  test('says when the spec is the report itself', async () => {
    expect(await propose({ ticket: 4 }, ctx({ drafted: false }))).toMatchObject({ specSource: 'report' })
  })

  test('keeps the title and spec it is given, drafting nothing', async () => {
    const c = ctx()
    expect(await propose({ ticket: 4, title: 'Speed up login', spec: 'Cache it.' }, c)).toMatchObject({
      title: 'Speed up login',
      spec: 'Cache it.',
      specSource: 'orchestrator'
    })
    expect(c.draftPromotionSpec).not.toHaveBeenCalled()
  })

  test('refuses what is wrong, naming the field or the reason', async () => {
    await expect(propose({})).rejects.toThrow(/^ticket: /)
    await expect(propose({ ticket: 99 })).rejects.toThrow('ticket: there is no ticket #99')
    await expect(propose({ ticket: 4, title: '  ' })).rejects.toThrow(/^title: /)
    await expect(propose({ ticket: 4, extra: 1 })).rejects.toThrow('Unknown field: extra')
    await expect(propose({ ticket: 4 }, ctx({ why: '#4 has no report yet' }))).rejects.toThrow('ticket: #4 has no report yet')
    await expect(propose({ ticket: 4 }, ctx({ why: 'x' }))).rejects.toThrow(ProposalInvalid)
  })
})

describe('promote: override', () => {
  const stored: PromotePayload = { ticketId: 't4', number: 4, fromTitle: 'Why', title: 'T', spec: 'S', specSource: 'summary' }

  test('changes the title and spec and keeps the engine fields', () => {
    expect(promote.override!(stored, { title: 'New', spec: 'Edited' })).toEqual({ ...stored, title: 'New', spec: 'Edited' })
  })

  test('validates like a proposal', () => {
    expect(() => promote.override!(stored, { title: '  ', spec: 'x' })).toThrow(ProposalInvalid)
    expect(() => promote.override!(stored, { title: 'x' })).toThrow(ProposalInvalid)
    expect(() => promote.override!(stored, { title: 'x', spec: 'y', ticketId: 'other' })).toThrow('Unknown field: ticketId')
  })
})

describe('promote: execute and outcome', () => {
  const payload: PromotePayload = { ticketId: 't4', number: 4, fromTitle: 'Why', title: 'Speed up login', spec: 'S', specSource: 'summary' }
  const target = { workspaceId: 'ws1', proposalId: 'p1' }

  test('promotes through the shared path with the stored title and spec', async () => {
    const c = ctx()
    expect(await promote.execute(payload, target, c)).toEqual({ ticketId: 't7', number: 7, title: 'Speed up login', fromTicketId: 't4', fromNumber: 4 })
    expect(c.promoteTicket).toHaveBeenCalledWith('t4', { title: 'Speed up login', spec: 'S' })
  })

  test('fails when the workspace or the ticket is gone, promoting nothing', async () => {
    const closed = ctx({ open: null })
    await expect(promote.execute(payload, target, closed)).rejects.toThrow('was removed')
    const gone = ctx({ ticket: null })
    await expect(promote.execute(payload, target, gone)).rejects.toThrow('no longer exists')
    expect(closed.promoteTicket).not.toHaveBeenCalled()
    expect(gone.promoteTicket).not.toHaveBeenCalled()
  })

  test('tells the orchestrator what was promoted', () => {
    expect(promote.outcome({ ticketId: 't7', number: 7, title: 'Speed up login', fromTicketId: 't4', fromNumber: 4 })).toBe(
      'Promoted #4 to #7 "Speed up login" in Ready; #4 is now Done.'
    )
  })
})
