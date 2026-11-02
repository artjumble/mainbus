import { describe, expect, test, vi } from 'vitest'
import type { Hold, Ticket, Workspace } from '../../shared/domain'
import type { CreateTicketsPayload } from '../../shared/proposals'
import { createTickets, listJoin } from './createTickets'
import { ProposalInvalid, type ExecContext } from './kind'

const MESSAGE = '  Please add two tickets:\n login and logout.  '

const ws: Workspace = {
  id: 'ws1',
  name: 'repo',
  repoPath: '/repo',
  baseBranch: 'main',
  slug: 'repo',
  openPrOnReview: false
}

function propose(input: unknown): CreateTicketsPayload {
  // It reads nothing from the board, so it needs no context, and it is synchronous.
  return createTickets.propose(input, { userMessage: MESSAGE, workspaceId: ws.id }, {} as ExecContext) as CreateTicketsPayload
}

describe('create_tickets: propose', () => {
  test('fills in the intent with the user message verbatim, and normalises the drafts', () => {
    expect(propose({ tickets: [{ title: 'Login', spec: 'Use a form', criteria: ['works'], labels: ['auth'] }, { title: 'Logout' }] })).toEqual({
      intent: MESSAGE,
      tickets: [
        { title: 'Login', spec: 'Use a form', criteria: ['works'], labels: ['auth'] },
        { title: 'Logout', spec: '', criteria: [], labels: [] }
      ],
      column: 'backlog'
    })
    expect(propose({ tickets: [{ title: 'A' }], column: 'ready' }).column).toBe('ready')
  })

  test.each([
    [{ tickets: [{ title: 'A', intent: 'The user wants A' }] }, 'Unknown field: tickets.0.intent'],
    [{ intent: 'The user wants A', tickets: [{ title: 'A' }] }, 'Unknown field: intent'],
    [{ tickets: [] }, 'tickets: must have at least 1 ticket'],
    [{ tickets: [{ title: '' }] }, 'tickets.0.title: must not be empty'],
    [{ tickets: [{ title: 'A' }, { title: 'two\nlines' }] }, 'tickets.1.title: must be a single line'],
    [{ tickets: [{ title: 'A', labels: ['x'.repeat(51)] }] }, 'tickets.0.labels.0: must be at most 50 characters'],
    [{ tickets: [{ title: 'A' }], column: 'done' }, 'column:'],
    [{ tickets: Array.from({ length: 21 }, () => ({ title: 'A' })) }, 'tickets: must have at most 20 tickets'],
    ['tickets', 'payload:']
  ])('refuses %j', (input, message) => {
    expect(() => propose(input)).toThrow(ProposalInvalid)
    expect(() => propose(input)).toThrow(message)
  })
})

describe('create_tickets: override', () => {
  const stored = propose({ tickets: [{ title: 'Login' }, { title: 'Logout' }] })

  test('takes the edited drafts and column, and keeps the stored intent', () => {
    const edited = createTickets.override!(stored, { tickets: [{ title: 'Sign in', spec: 'Edited', criteria: [], labels: [] }], column: 'ready' })
    expect(edited).toEqual({
      intent: MESSAGE,
      tickets: [{ title: 'Sign in', spec: 'Edited', criteria: [], labels: [] }],
      column: 'ready'
    })
  })

  test('validates like a proposal, and never takes an intent from it', () => {
    expect(() => createTickets.override!(stored, { tickets: [] })).toThrow('tickets: must have at least 1 ticket')
    expect(() => createTickets.override!(stored, { tickets: [{ title: 'A' }], intent: 'Something else' })).toThrow(
      'Unknown field: intent'
    )
  })
})

describe('create_tickets: execute and outcome', () => {
  function ctx(open: Workspace | null = ws): ExecContext & { createTickets: ReturnType<typeof vi.fn> } {
    let n = 20
    return {
      workspace: async () => open,
      createTickets: vi.fn(async (_ws: Workspace, inputs: { title: string }[]) =>
        inputs.map((i) => ({ id: `t${++n}`, number: n, title: i.title }) as Ticket)
      ),
      lineup: async () => [],
      ticketByNumber: async () => null,
      whyNotStartable: async () => null,
      startTicket: vi.fn(),
      activeRole: async () => null,
      pauseTicket: async () => {},
      stopTicket: async () => {},
      skipTicket: async () => {},
      now: () => new Date(),
      holdTicket: async () => ({}) as Hold,
      decision: async () => null,
      openStuckEpisode: async () => null,
      redirectTicket: async () => {},
      replaceTicket: async () => {},
      answerDecision: async () => {}
    }
  }

  test('creates the drafts in order, each with the stored intent and no source, in the column', async () => {
    const c = ctx()
    const p = propose({ tickets: [{ title: 'Login', spec: 'S', criteria: ['c'], labels: ['l'] }, { title: 'Logout' }], column: 'ready' })
    const result = await createTickets.execute(p, { workspaceId: 'ws1', proposalId: 'p1' }, c)
    expect(c.createTickets).toHaveBeenCalledWith(ws, [
      { title: 'Login', intent: MESSAGE, spec: 'S', criteria: ['c'], labels: ['l'], column: 'ready' },
      { title: 'Logout', intent: MESSAGE, spec: '', criteria: [], labels: [], column: 'ready' }
    ], { proposalId: 'p1', column: 'ready' })
    expect(result).toEqual({
      tickets: [
        { id: 't21', number: 21, title: 'Login' },
        { id: 't22', number: 22, title: 'Logout' }
      ],
      column: 'ready'
    })
    expect(createTickets.outcome(result)).toBe('Created #21 "Login" and #22 "Logout" in Ready.')
  })

  test('refuses when the workspace it was proposed for is no longer open', async () => {
    const p = propose({ tickets: [{ title: 'Login' }] })
    await expect(createTickets.execute(p, { workspaceId: 'other', proposalId: 'p1' }, ctx())).rejects.toThrow('no longer open')
    await expect(createTickets.execute(p, { workspaceId: 'ws1', proposalId: 'p1' }, ctx(null))).rejects.toThrow('no longer open')
  })

  test('listJoin', () => {
    expect(listJoin([])).toBe('')
    expect(listJoin(['#1'])).toBe('#1')
    expect(listJoin(['#1', '#2'])).toBe('#1 and #2')
    expect(listJoin(['#1', '#2', '#3'])).toBe('#1, #2 and #3')
  })
})
