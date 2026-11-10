import { describe, expect, test, vi } from 'vitest'
import type { Hold, Ticket, Workspace } from '../../shared/domain'
import type { CreateTicketsPayload } from '../../shared/proposals'
import { CONTEXT_MAX, createInBacklog, createTickets, listJoin, MAX_DRAFTS } from './createTickets'
import { ProposalInvalid, type ExecContext } from './kind'

const MESSAGE = '  Please add two tickets:\n login and logout.  '

const ws: Workspace = {
  id: 'ws1',
  name: 'repo',
  repoPath: '/repo',
  baseBranch: 'main',
  slug: 'repo',
  openPrOnReview: false,
  mergeMethod: 'merge',
  saveReports: true,
  reportsFolder: 'docs/investigations',
  setupCommand: '',
  setupTimeoutMinutes: 15,
  testCommands: []
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

describe('create_tickets: kind', () => {
  test('is optional and kept as sent, in propose and in override', () => {
    const stored = propose({ tickets: [{ title: 'Why slow', kind: 'investigate' }, { title: 'Fix' }] })
    expect(stored.tickets.map((t) => t.kind)).toEqual(['investigate', undefined])
    const edited = createTickets.override!(stored, { tickets: [{ title: 'Why slow', kind: 'investigate' }], column: 'ready' })
    expect(edited.tickets[0]!.kind).toBe('investigate')
  })

  test('refuses an unknown kind', () => {
    expect(() => propose({ tickets: [{ title: 'A', kind: 'research' }] })).toThrow(ProposalInvalid)
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
      orchestratorFolder: '/home/orchestrator',
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
      whyNotPromotable: async () => null,
      draftPromotionSpec: async () => ({ spec: '', drafted: false }),
      promoteTicket: async () => { throw new Error('not expected') },
      answerDecision: async () => {},
      whyNotUpdatable: async () => null,
      freshnessOf: () => null,
      updateFromMain: async () => {},
      mergePreview: async () => ({ ok: false as const, reason: 'n/a', suggest: null }),
      mergeTicket: async () => { throw new Error('n/a') }
    }
  }

  test('is passed on when creating, change by default', async () => {
    const c = ctx()
    const p = propose({ tickets: [{ title: 'Why slow', kind: 'investigate' }, { title: 'Fix' }] })
    await createTickets.execute(p, { workspaceId: 'ws1', proposalId: 'p1' }, c)
    const inputs = c.createTickets.mock.calls[0]![1]
    expect(inputs.map((i: { kind?: string }) => i.kind)).toEqual(['investigate', 'change'])
  })

  test('creates the drafts in order, each with the stored intent and no source, in the column', async () => {
    const c = ctx()
    const p = propose({ tickets: [{ title: 'Login', spec: 'S', criteria: ['c'], labels: ['l'] }, { title: 'Logout' }], column: 'ready' })
    const result = await createTickets.execute(p, { workspaceId: 'ws1', proposalId: 'p1' }, c)
    expect(c.createTickets).toHaveBeenCalledWith(ws, [
      { title: 'Login', intent: MESSAGE, spec: 'S', criteria: ['c'], labels: ['l'], column: 'ready', kind: 'change' },
      { title: 'Logout', intent: MESSAGE, spec: '', criteria: [], labels: [], column: 'ready', kind: 'change' }
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

  test('refuses when the workspace it was proposed for is was removed', async () => {
    const p = propose({ tickets: [{ title: 'Login' }] })
    await expect(createTickets.execute(p, { workspaceId: 'other', proposalId: 'p1' }, ctx())).rejects.toThrow('was removed')
    await expect(createTickets.execute(p, { workspaceId: 'ws1', proposalId: 'p1' }, ctx(null))).rejects.toThrow('was removed')
  })

  test("keeps the user's later messages from propose through override to the created tickets", async () => {
    const followUps = [{ text: 'With SSO', at: '2026-11-03T10:00:00.000Z' }]
    const stored = createTickets.propose({ tickets: [{ title: 'Login' }] }, { userMessage: MESSAGE, followUps, workspaceId: ws.id }, {} as ExecContext) as CreateTicketsPayload
    expect(stored.intentAdded).toEqual(followUps)
    const edited = createTickets.override!(stored, { tickets: [{ title: 'Sign in' }], column: 'ready' })
    expect(edited).toMatchObject({ intent: MESSAGE, intentAdded: followUps })
    const c = ctx()
    await createTickets.execute(edited, { workspaceId: 'ws1', proposalId: 'p1' }, c)
    expect(c.createTickets.mock.calls[0]![1]).toEqual([
      { title: 'Sign in', intent: MESSAGE, intentAdded: followUps, spec: '', criteria: [], labels: [], column: 'ready', kind: 'change' }
    ])
    // A proposal stored before it was kept has none, and none is passed on.
    expect(propose({ tickets: [{ title: 'A' }] })).not.toHaveProperty('intentAdded')
  })

  test('a context is stored trimmed, limited, edited or cleared by an override, and passed on as an entry of the orchestrator', async () => {
    expect(propose({ tickets: [{ title: 'A' }] })).not.toHaveProperty('context')
    expect(propose({ tickets: [{ title: 'A' }], context: '   ' })).not.toHaveProperty('context')
    const stored = propose({ tickets: [{ title: 'A' }], context: '  The user asked.  ' })
    expect(stored.context).toBe('The user asked.')
    expect(() => propose({ tickets: [{ title: 'A' }], context: 'x'.repeat(CONTEXT_MAX + 1) })).toThrow(new ProposalInvalid('context: must be at most 4000 characters'))
    expect(propose({ tickets: [{ title: 'A' }], context: 'x'.repeat(CONTEXT_MAX) }).context).toHaveLength(CONTEXT_MAX)
    expect(() => propose({ tickets: [{ title: 'A' }], context: 5 })).toThrow(ProposalInvalid)
    expect(createTickets.override!(stored, { tickets: [{ title: 'A' }], column: 'backlog', context: 'Edited' }).context).toBe('Edited')
    // Never falls back to the stored one: leaving it out clears it.
    expect(createTickets.override!(stored, { tickets: [{ title: 'A' }], column: 'backlog' })).not.toHaveProperty('context')
    const c = ctx()
    await createTickets.execute(stored, { workspaceId: 'ws1', proposalId: 'p1' }, c)
    expect(c.createTickets.mock.calls[0]![1][0]).toMatchObject({
      intent: MESSAGE,
      agentContext: { text: 'The user asked.', source: { kind: 'agent', agent: 'orchestrator', cwd: '/home/orchestrator' } }
    })
  })

  test('listJoin', () => {
    expect(listJoin([])).toBe('')
    expect(listJoin(['#1'])).toBe('#1')
    expect(listJoin(['#1', '#2'])).toBe('#1 and #2')
    expect(listJoin(['#1', '#2', '#3'])).toBe('#1, #2 and #3')
  })
})

describe('create_tickets: images', () => {
  const images = [
    { id: 'img-1', filename: 'menu.png' },
    { id: 'img-2', filename: 'footer.png' }
  ]
  const proposeWith = (input: unknown) =>
    createTickets.propose(input, { userMessage: MESSAGE, workspaceId: ws.id, images }, {} as ExecContext) as CreateTicketsPayload

  test("names the request's images by name, ignoring case, each once", () => {
    const p = proposeWith({ tickets: [{ title: 'A', images: ['MENU.png', ' footer.png', 'menu.png'] }, { title: 'B' }] })
    expect(p.tickets[0]!.images).toEqual(images)
    expect(p.tickets[1]).not.toHaveProperty('images')
  })

  test('refuses an image the user did not send with the request, naming the ones they did', () => {
    expect(() => proposeWith({ tickets: [{ title: 'A', images: ['other.png'] }] })).toThrow(
      new ProposalInvalid("tickets.0.images: other.png is not an image the user sent in the request's messages (those are menu.png, footer.png)")
    )
    expect(() => propose({ tickets: [{ title: 'A', images: ['menu.png'] }] })).toThrow(/\(they sent none\)$/)
    expect(() => proposeWith({ tickets: [{ title: 'A', images: [3] }] })).toThrow(ProposalInvalid)
  })

  test('an override keeps the images it names by id, and can add none of its own', () => {
    const stored = proposeWith({ tickets: [{ title: 'A', images: ['menu.png', 'footer.png'] }] })
    const kept = createTickets.override!(stored, { tickets: [{ title: 'A', spec: '', criteria: [], labels: [], images: ['img-2'] }], column: 'backlog' }, new Date())
    expect(kept.tickets[0]!.images).toEqual([{ id: 'img-2', filename: 'footer.png' }])
    const none = createTickets.override!(stored, { tickets: [{ title: 'A', spec: '', criteria: [], labels: [] }], column: 'backlog' }, new Date())
    expect(none.tickets[0]).not.toHaveProperty('images')
    expect(() =>
      createTickets.override!(stored, { tickets: [{ title: 'A', spec: '', criteria: [], labels: [], images: ['menu.png'] }], column: 'backlog' }, new Date())
    ).toThrow("tickets.0.images: menu.png is not one of the proposal's images")
  })

  test('passes the ids on to be attached, and the result and outcome count them', async () => {
    const created: unknown[] = []
    const ctx = {
      orchestratorFolder: '/home/orchestrator',
      workspace: async () => ws,
      createTickets: async (_ws: Workspace, inputs: { title: string }[]) => {
        created.push(...inputs)
        return inputs.map((i, n) => ({ id: `t${n}`, number: n + 1, title: i.title }) as Ticket)
      }
    } as unknown as ExecContext
    const p = proposeWith({ tickets: [{ title: 'A', images: ['menu.png', 'footer.png'] }, { title: 'B', images: ['footer.png'] }] })
    const result = await createTickets.execute(p, { workspaceId: ws.id, proposalId: 'p1' }, ctx)
    expect(created).toMatchObject([{ title: 'A', images: ['img-1', 'img-2'] }, { title: 'B', images: ['img-2'] }])
    expect(result.images).toBe(3)
    expect(createTickets.outcome(result)).toBe('Created #1 "A" and #2 "B" in Backlog, with 3 images attached.')
    expect(createTickets.outcome({ ...result, images: undefined })).toBe('Created #1 "A" and #2 "B" in Backlog.')
  })

  test('createInBacklog attaches them too, and counts them', async () => {
    const create = vi.fn(async (_ws: Workspace, inputs: { title: string }[]) => inputs.map((i, n) => ({ id: `t${n}`, number: n + 1, title: i.title }) as Ticket))
    const made = await createInBacklog({ tickets: [{ title: 'A', images: ['menu.png'] }] }, { userMessage: MESSAGE, images }, ws, create, '/o')
    expect(made.images).toBe(1)
    expect(create.mock.calls[0]![1]).toMatchObject([{ images: ['img-1'] }])
    await expect(createInBacklog({ tickets: [{ title: 'A', images: ['nope.png'] }] }, { userMessage: MESSAGE, images }, ws, create, '/o')).rejects.toThrow(ProposalInvalid)
    expect(create).toHaveBeenCalledTimes(1)
  })
})

describe('createInBacklog', () => {
  const create = () =>
    vi.fn(async (_ws: Workspace, inputs: { title: string }[]) => inputs.map((i, n) => ({ id: `t${n + 1}`, number: n + 1, title: i.title }) as Ticket))

  test('creates every draft in Backlog, marked as the orchestrator creating it at the user request, with no source', async () => {
    const c = create()
    const followUps = [{ text: 'website', at: '2026-11-03T10:00:00.000Z' }]
    const made = await createInBacklog({ tickets: [{ title: 'Login', spec: 'S' }, { title: 'Why', kind: 'investigate' }] }, { userMessage: MESSAGE, followUps }, ws, c, '/home/orchestrator')
    expect(made.withContext).toBe(false)
    expect(made.created.map((t) => t.number)).toEqual([1, 2])
    expect(c).toHaveBeenCalledTimes(1)
    expect(c).toHaveBeenCalledWith(ws, [
      { title: 'Login', intent: MESSAGE, intentAdded: followUps, spec: 'S', criteria: [], labels: [], column: 'backlog', kind: 'change', via: 'orchestrator' },
      { title: 'Why', intent: MESSAGE, intentAdded: followUps, spec: '', criteria: [], labels: [], column: 'backlog', kind: 'investigate', via: 'orchestrator' }
    ])
  })

  test('adds a context as an entry written by the orchestrator, from the folder it is given', async () => {
    const c = create()
    const made = await createInBacklog({ tickets: [{ title: 'A' }], context: '  The user asked.  ' }, { userMessage: MESSAGE }, ws, c, '/h/orchestrator')
    expect(made.withContext).toBe(true)
    expect(c.mock.calls[0]![1][0]).toMatchObject({
      intent: MESSAGE,
      agentContext: { text: 'The user asked.', source: { kind: 'agent', agent: 'orchestrator', cwd: '/h/orchestrator' } }
    })
  })

  test('a blank context is none', async () => {
    const c = create()
    const made = await createInBacklog({ tickets: [{ title: 'A' }], context: '  ' }, { userMessage: MESSAGE }, ws, c, '/h/orchestrator')
    expect(made.withContext).toBe(false)
    expect(c.mock.calls[0]![1][0]).not.toHaveProperty('agentContext')
  })

  test('refuses a context over the limit, and takes exactly the limit', async () => {
    const c = create()
    await expect(createInBacklog({ tickets: [{ title: 'A' }], context: 'x'.repeat(CONTEXT_MAX + 1) }, { userMessage: MESSAGE }, ws, c, '/o')).rejects.toThrow(
      new ProposalInvalid('context: must be at most 4000 characters')
    )
    await expect(createInBacklog({ tickets: [{ title: 'A' }], context: 'x'.repeat(CONTEXT_MAX) }, { userMessage: MESSAGE }, ws, c, '/o')).resolves.toBeDefined()
    await expect(createInBacklog({ tickets: [{ title: 'A' }], context: 5 }, { userMessage: MESSAGE }, ws, c, '/o')).rejects.toThrow(ProposalInvalid)
  })

  test.each([
    [{ tickets: [{ title: 'A' }, { title: '' }] }, 'tickets.1.title: must not be empty'],
    [{ tickets: Array.from({ length: MAX_DRAFTS + 1 }, (_, i) => ({ title: `T${i}` })) }, 'tickets: must have at most 20 tickets'],
    [{ tickets: [{ title: 'A' }], column: 'ready' }, 'Unknown field: column'],
    [{ tickets: [{ title: 'A' }], column: 'backlog' }, 'Unknown field: column'],
    [{ tickets: [{ title: 'A', intent: 'Mine' }] }, 'Unknown field: tickets.0.intent']
  ])('refuses %j, creating nothing', async (input, error) => {
    const c = create()
    await expect(createInBacklog(input, { userMessage: MESSAGE }, ws, c, '/home/orchestrator')).rejects.toThrow(new ProposalInvalid(error))
    expect(c).not.toHaveBeenCalled()
  })

  test('refuses with no message of the user', async () => {
    const c = create()
    await expect(createInBacklog({ tickets: [{ title: 'A' }] }, { userMessage: null }, ws, c, '/home/orchestrator')).rejects.toThrow(ProposalInvalid)
    expect(c).not.toHaveBeenCalled()
  })
})

describe('create_tickets: blocked_by', () => {
  const byNumber = async (n: number) => (n === 5 ? ({ id: 't5', number: 5 } as Ticket) : null)
  const proposeWith = (input: unknown) =>
    Promise.resolve(createTickets.propose(input, { userMessage: MESSAGE, workspaceId: ws.id }, { ticketByNumber: (_w: string, n: number) => byNumber(n) } as unknown as ExecContext))

  test('keeps ticket numbers and draft indexes on the drafts', async () => {
    const p = await proposeWith({ tickets: [{ title: 'A', blocked_by: [5] }, { title: 'B', blocked_by: [{ draft: 0 }, 5] }] })
    expect(p.tickets.map((t) => t.blocked_by)).toEqual([[5], [{ draft: 0 }, 5]])
  })

  test('refuses an unknown ticket, and a draft index that is not an earlier draft', async () => {
    await expect(proposeWith({ tickets: [{ title: 'A', blocked_by: [9] }] })).rejects.toThrow('tickets.0.blocked_by: there is no ticket #9')
    expect(() => proposeWith({ tickets: [{ title: 'A', blocked_by: [{ draft: 0 }] }] })).toThrow("tickets.0.blocked_by: draft 0 isn't an earlier ticket")
    expect(() => proposeWith({ tickets: [{ title: 'A' }, { title: 'B', blocked_by: [{ draft: 1 }] }] })).toThrow(ProposalInvalid)
    expect(() => proposeWith({ tickets: [{ title: 'A', blocked_by: [{ draft: -1 }] }] })).toThrow(ProposalInvalid)
  })

  test('an override is checked for draft indexes too', async () => {
    const stored = await proposeWith({ tickets: [{ title: 'A' }, { title: 'B', blocked_by: [{ draft: 0 }] }] })
    const kept = createTickets.override!(stored, { tickets: [{ title: 'B', blocked_by: [5] }], column: 'backlog' })
    expect(kept.tickets[0]!.blocked_by).toEqual([5])
    expect(() => createTickets.override!(stored, { tickets: [{ title: 'B', blocked_by: [{ draft: 0 }] }], column: 'backlog' })).toThrow(ProposalInvalid)
  })

  test('creating passes ids and draft indexes to the engine', async () => {
    const create = vi.fn(async (_ws: Workspace, inputs: { title: string }[]) => inputs.map((i, n) => ({ id: `n${n}`, number: n + 1, title: i.title }) as Ticket))
    const p = await proposeWith({ tickets: [{ title: 'A', blocked_by: [5] }, { title: 'B', blocked_by: [{ draft: 0 }] }, { title: 'C' }] })
    await createTickets.execute(
      p,
      { workspaceId: 'ws1', proposalId: 'p1' },
      { workspace: async () => ws, createTickets: create, ticketByNumber: (_w: string, n: number) => byNumber(n), orchestratorFolder: '/o' } as unknown as ExecContext
    )
    const inputs = create.mock.calls[0]![1] as { blockedBy?: unknown }[]
    expect(inputs.map((i) => i.blockedBy)).toEqual([[{ id: 't5' }], [{ draft: 0 }], undefined])
  })

  test('create_tickets resolves the same way, and creates nothing for a bad reference', async () => {
    const create = vi.fn(async (_ws: Workspace, inputs: { title: string }[]) => inputs.map((i, n) => ({ id: `n${n}`, number: n + 1, title: i.title }) as Ticket))
    const turn = { userMessage: MESSAGE }
    await createInBacklog({ tickets: [{ title: 'A', blocked_by: [5] }, { title: 'B', blocked_by: [{ draft: 0 }] }] }, turn, ws, create, '/o', byNumber)
    expect((create.mock.calls[0]![1] as { blockedBy?: unknown }[]).map((i) => i.blockedBy)).toEqual([[{ id: 't5' }], [{ draft: 0 }]])
    create.mockClear()
    await expect(createInBacklog({ tickets: [{ title: 'A', blocked_by: [9] }] }, turn, ws, create, '/o', byNumber)).rejects.toThrow('there is no ticket #9')
    expect(create).not.toHaveBeenCalled()
  })
})
