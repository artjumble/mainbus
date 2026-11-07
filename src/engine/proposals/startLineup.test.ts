import { describe, expect, test, vi } from 'vitest'
import type { Hold, Lineup, LineupRole, StartOptions, Ticket, Workspace } from '../../shared/domain'
import type { StartLineupPayload } from '../../shared/proposals'
import { testRole } from '../store/testDb'
import { ProposalInvalid, type ExecContext } from './kind'
import { startLineup } from './startLineup'

const ws: Workspace = { id: 'ws1', name: 'repo', repoPath: '/repo', baseBranch: 'main', slug: 'repo', openPrOnReview: false, saveReports: true, reportsFolder: 'docs/investigations' }

const LINEUP: LineupRole[] = [
  testRole({ id: 'p', name: 'Planner', position: 1 }),
  testRole({ id: 'i', name: 'Implementer', position: 2, model: 'sonnet' }),
  testRole({ id: 'r', name: 'Reviewer', position: 3 })
]

const TICKET = { id: 't12', number: 12, title: 'Rate-limit login', kind: 'change', runSettings: null } as Ticket

/** A fake engine: ticket #12 exists (`ticket` changes it); `why` says whether it can be started now. */
function ctx(over: { why?: string | null; open?: Workspace | null; lineup?: LineupRole[]; ticket?: Ticket } = {}) {
  let why = over.why ?? null
  const c = {
    orchestratorFolder: '/home/orchestrator',
    workspace: async () => (over.open === undefined ? ws : over.open),
    createTickets: async () => [],
    lineup: vi.fn(async (_w: string, _kind: Lineup) => over.lineup ?? LINEUP),
    ticketByNumber: async (_w: string, n: number) => (n === 12 ? (over.ticket ?? TICKET) : null),
    whyNotStartable: vi.fn(async () => why),
    startTicket: vi.fn(async (_id: string, _opts: StartOptions) => {}),
    activeRole: async () => null,
    pauseTicket: async () => {},
    stopTicket: async () => {},
    skipTicket: async () => {},
    now: () => new Date('2026-10-30T12:00:00.000Z'),
    holdTicket: async () => ({}) as Hold,
    decision: async () => null,
    openStuckEpisode: async () => null,
    redirectTicket: async () => {},
    replaceTicket: async () => {},
    whyNotPromotable: async () => null,
    draftPromotionSpec: async () => ({ spec: '', drafted: false }),
    promoteTicket: async () => { throw new Error('not expected') },
    answerDecision: async () => {},
    /** Changes what whyNotStartable says from now on. */
    setWhy: (w: string | null) => (why = w)
  }
  return c satisfies ExecContext
}

const turn = { userMessage: 'Start #12', workspaceId: ws.id }

function propose(input: unknown, c: ExecContext = ctx()): Promise<StartLineupPayload> {
  return Promise.resolve(startLineup.propose(input, turn, c))
}

describe('start_lineup: propose', () => {
  test('omitting roles means the whole lineup, resolved by role setting, else the defaults', async () => {
    expect(await propose({ ticket: 12 })).toEqual({
      ticketId: 't12',
      number: 12,
      title: 'Rate-limit login',
      roles: [
        { roleId: 'p', name: 'Planner', model: 'opus', effort: 'high', source: 'default' },
        { roleId: 'i', name: 'Implementer', model: 'sonnet', effort: 'medium', source: 'role' },
        { roleId: 'r', name: 'Reviewer', model: 'opus', effort: 'medium', source: 'default' }
      ],
      extraInstructions: null
    })
  })

  test("puts the roles in lineup order; a role's own setting beats the orchestrator's choice", async () => {
    const p = await propose({
      ticket: 12,
      roles: [
        { role: 'reviewer', model: 'haiku', effort: 'low' },
        { role: 'Implementer', model: 'opus', effort: 'max' }
      ],
      extraInstructions: '  Keep the diff small.  '
    })
    expect(p.roles).toEqual([
      { roleId: 'i', name: 'Implementer', model: 'sonnet', effort: 'max', source: 'role' },
      { roleId: 'r', name: 'Reviewer', model: 'haiku', effort: 'low', source: 'orchestrator' }
    ])
    expect(p.extraInstructions).toBe('Keep the diff small.')
  })

  test.each([
    [{ ticket: 99 }, 'ticket: there is no ticket #99'],
    [{ ticket: 12, roles: [{ role: 'Tester' }] }, 'roles: there is no role "Tester" in the lineup; its roles are "Planner", "Implementer", "Reviewer"'],
    [{ ticket: 12, roles: [{ role: 'Planner' }, { role: 'planner' }] }, 'roles: Planner is listed twice'],
    [{ ticket: 12, roles: [] }, 'roles: must have at least 1 role'],
    [{ ticket: 12, roles: [{ role: 'Planner', model: 'gpt-4' }] }, /^roles\.0\.model: /],
    [{ ticket: 12, roles: [{ role: 'Planner', effort: 'huge' }] }, /^roles\.0\.effort: /],
    [{ ticket: 12, column: 'ready' }, 'Unknown field: column'],
    [{ ticket: 12, extraInstructions: 'x'.repeat(10_001) }, 'extraInstructions: must be at most 10000 characters'],
    [{ ticket: 'twelve' }, /^ticket: /]
  ])('rejects %j', async (input, message) => {
    const err = await propose(input).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProposalInvalid)
    expect((err as Error).message).toMatch(message)
  })

  test('rejects a ticket the engine says it cannot start, with its reason', async () => {
    const running = ctx({ why: '#12 is already running' })
    await expect(propose({ ticket: 12 }, running)).rejects.toThrow('ticket: #12 is already running')
    const inReview = ctx({ why: '#12 is in Review; only Backlog or Ready tickets can be started' })
    await expect(propose({ ticket: 12 }, inReview)).rejects.toThrow(
      'ticket: #12 is in Review; only Backlog or Ready tickets can be started'
    )
    expect(inReview.whyNotStartable).toHaveBeenCalledWith(TICKET)
  })

  test('rejects a workspace with no roles', async () => {
    await expect(propose({ ticket: 12 }, ctx({ lineup: [] }))).rejects.toThrow('roles: this workspace has no roles')
  })
})

describe("start_lineup: the ticket's saved run settings", () => {
  // The user left out the Planner and chose Opus for the Reviewer, with extra instructions.
  const saved = ctx({
    ticket: {
      ...TICKET,
      runSettings: {
        excludedRoleIds: ['p'],
        roles: { r: { model: 'opus' } },
        extraInstructions: 'Use the existing limiter.',
        roleNames: { p: 'Planner', r: 'Reviewer' }
      }
    }
  })

  test('with no roles (a drag into In progress), the card is the saved settings', async () => {
    expect(await propose({ ticket: 12 }, saved)).toEqual({
      ticketId: 't12',
      number: 12,
      title: 'Rate-limit login',
      roles: [
        { roleId: 'i', name: 'Implementer', model: 'sonnet', effort: 'medium', source: 'role' },
        { roleId: 'r', name: 'Reviewer', model: 'opus', effort: 'medium', source: 'user' }
      ],
      extraInstructions: 'Use the existing limiter.'
    })
  })

  test("the user's roles, model and extra instructions win; the orchestrator only fills in what's left", async () => {
    const p = await propose(
      {
        ticket: 12,
        roles: [
          { role: 'Planner', model: 'haiku' },
          { role: 'Reviewer', model: 'haiku', effort: 'high' }
        ],
        extraInstructions: 'Rewrite it all.'
      },
      saved
    )
    // The Planner stays out, the Implementer the user kept runs, and the Reviewer keeps the user's Opus but takes the orchestrator's effort.
    expect(p.roles).toEqual([
      { roleId: 'i', name: 'Implementer', model: 'sonnet', effort: 'medium', source: 'role' },
      { roleId: 'r', name: 'Reviewer', model: 'opus', effort: 'high', source: 'user' }
    ])
    expect(p.extraInstructions).toBe('Use the existing limiter.')
  })

  test("with no saved extra instructions, the orchestrator's are used", async () => {
    const t = { ...TICKET, runSettings: { excludedRoleIds: [], roles: {}, extraInstructions: null, roleNames: {} } }
    const p = await propose({ ticket: 12, extraInstructions: 'Mine.' }, ctx({ ticket: t }))
    expect(p.extraInstructions).toBe('Mine.')
    expect(p.roles.map((r) => r.roleId)).toEqual(['p', 'i', 'r'])
  })
})

describe('start_lineup: the kind of the ticket', () => {
  test('asks for the lineup of the ticket kind', async () => {
    const c = ctx()
    await propose({ ticket: 12 }, c)
    expect(c.lineup).toHaveBeenLastCalledWith(ws.id, 'change')
    const investigate = { ...TICKET, kind: 'investigate' as const }
    const d = { ...c, ticketByNumber: async () => investigate }
    await propose({ ticket: 12 }, d)
    expect(c.lineup).toHaveBeenLastCalledWith(ws.id, 'investigate')
  })
})

describe('start_lineup: override', () => {
  async function stored(): Promise<StartLineupPayload> {
    return propose({ ticket: 12, extraInstructions: 'Be careful.' })
  }

  test('keeps the ticked roles in their order with the chosen model and effort, as the user chose them', async () => {
    const s = await stored()
    const o = startLineup.override!(s, {
      roles: [
        { roleId: 'r', model: 'sonnet', effort: 'high' },
        { roleId: 'i', model: 'opus', effort: 'low' }
      ],
      extraInstructions: '  New words. '
    })
    expect(o).toEqual({
      ...s,
      roles: [
        { roleId: 'i', name: 'Implementer', model: 'opus', effort: 'low', source: 'user' },
        { roleId: 'r', name: 'Reviewer', model: 'sonnet', effort: 'high', source: 'user' }
      ],
      extraInstructions: 'New words.'
    })
    expect(startLineup.override!(s, { roles: [{ roleId: 'p', model: 'opus', effort: 'high' }], extraInstructions: ' ' }).extraInstructions).toBeNull()
  })

  test('accepts a model the role already had, even if it is not offered', async () => {
    const s = { ...(await stored()), roles: [{ roleId: 'i', name: 'Implementer', model: 'claude-x', effort: 'low' as const, source: 'role' as const }] }
    expect(startLineup.override!(s, { roles: [{ roleId: 'i', model: 'claude-x', effort: 'low' }], extraInstructions: '' }).roles[0]!.model).toBe('claude-x')
  })

  test.each([
    [{ roles: [], extraInstructions: '' }, 'roles: tick at least one role'],
    [{ roles: [{ roleId: 'zz', model: 'opus', effort: 'low' }], extraInstructions: '' }, 'roles: "zz" is not a role of this proposal'],
    [
      { roles: [{ roleId: 'p', model: 'opus', effort: 'low' }, { roleId: 'p', model: 'opus', effort: 'low' }], extraInstructions: '' },
      'roles: Planner is listed twice'
    ],
    [{ roles: [{ roleId: 'p', model: 'gpt-4', effort: 'low' }], extraInstructions: '' }, 'roles: Planner has an unknown model'],
    [{ roles: [{ roleId: 'p', model: 'opus', effort: 'huge' }], extraInstructions: '' }, /^roles\.0\.effort: /],
    [{ roles: [{ roleId: 'p', model: 'opus', effort: 'low' }], ticketId: 'other' }, 'Unknown field: ticketId']
  ])('rejects %j', async (input, message) => {
    const s = await stored()
    expect(() => startLineup.override!(s, input)).toThrow(ProposalInvalid)
    expect(() => startLineup.override!(s, input)).toThrow(message)
  })
})

describe('start_lineup: execute and outcome', () => {
  test('as proposed: starts the ticket with exactly the roles, models, effort and instructions on the card', async () => {
    const c = ctx()
    const p = await propose({ ticket: 12, roles: [{ role: 'Planner', model: 'haiku' }, { role: 'Reviewer' }], extraInstructions: 'Small.' }, c)
    const result = await startLineup.execute(p, { workspaceId: ws.id, proposalId: 'p1' }, c)
    expect(c.startTicket).toHaveBeenCalledWith('t12', {
      roleIds: ['p', 'r'],
      roles: { p: { model: 'haiku', effort: 'high' }, r: { model: 'opus', effort: 'medium' } },
      extraInstructions: 'Small.'
    })
    expect(result).toEqual({
      ticketId: 't12',
      number: 12,
      title: 'Rate-limit login',
      roles: [
        { name: 'Planner', model: 'haiku', effort: 'high' },
        { name: 'Reviewer', model: 'opus', effort: 'medium' }
      ]
    })
    expect(startLineup.outcome(result)).toBe('Started #12 "Rate-limit login" with Planner (haiku, high) and Reviewer (opus, medium).')
  })

  test('overridden: starts it with the override, and no extra instructions when they were cleared', async () => {
    const c = ctx()
    const p = await propose({ ticket: 12, extraInstructions: 'Small.' }, c)
    const o = startLineup.override!(p, { roles: [{ roleId: 'i', model: 'opus', effort: 'high' }], extraInstructions: '' })
    await startLineup.execute(o, { workspaceId: ws.id, proposalId: 'p1' }, c)
    expect(c.startTicket).toHaveBeenCalledWith('t12', { roleIds: ['i'], roles: { i: { model: 'opus', effort: 'high' } } })
  })

  test('fails, starting nothing, when the ticket started meanwhile or the workspace closed', async () => {
    const c = ctx()
    const p = await propose({ ticket: 12 }, c)
    c.setWhy('#12 is already running')
    await expect(startLineup.execute(p, { workspaceId: ws.id, proposalId: 'p1' }, c)).rejects.toThrow('#12 is already running')
    c.setWhy(null)
    await expect(startLineup.execute(p, { workspaceId: 'other', proposalId: 'p1' }, c)).rejects.toThrow('was removed')
    expect(c.startTicket).not.toHaveBeenCalled()
  })
})
