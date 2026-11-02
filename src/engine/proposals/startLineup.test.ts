import { describe, expect, test, vi } from 'vitest'
import type { LineupRole, StartOptions, Ticket, Workspace } from '../../shared/domain'
import type { StartLineupPayload } from '../../shared/proposals'
import { testRole } from '../store/testDb'
import { ProposalInvalid, type ExecContext } from './kind'
import { startLineup } from './startLineup'

const ws: Workspace = { id: 'ws1', name: 'repo', repoPath: '/repo', baseBranch: 'main', slug: 'repo', openPrOnReview: false }

const LINEUP: LineupRole[] = [
  testRole({ id: 'p', name: 'Planner', position: 1 }),
  testRole({ id: 'i', name: 'Implementer', position: 2, model: 'sonnet' }),
  testRole({ id: 'r', name: 'Reviewer', position: 3 })
]

const TICKET = { id: 't12', number: 12, title: 'Rate-limit login' } as Ticket

/** A fake engine: ticket #12 exists; `why` says whether it can be started now. */
function ctx(over: { why?: string | null; open?: Workspace | null; lineup?: LineupRole[] } = {}) {
  let why = over.why ?? null
  const c = {
    workspace: async () => (over.open === undefined ? ws : over.open),
    createTickets: async () => [],
    lineup: async () => over.lineup ?? LINEUP,
    ticketByNumber: async (_w: string, n: number) => (n === 12 ? TICKET : null),
    whyNotStartable: vi.fn(async () => why),
    startTicket: vi.fn(async (_id: string, _opts: StartOptions) => {}),
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

describe('start_lineup: override', () => {
  async function stored(): Promise<StartLineupPayload> {
    return propose({ ticket: 12, extraInstructions: 'Be careful.' })
  }

  test('keeps the ticked roles in their order with the chosen model and effort, as the user chose them', async () => {
    const s = await stored()
    const o = startLineup.override(s, {
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
    expect(startLineup.override(s, { roles: [{ roleId: 'p', model: 'opus', effort: 'high' }], extraInstructions: ' ' }).extraInstructions).toBeNull()
  })

  test('accepts a model the role already had, even if it is not offered', async () => {
    const s = { ...(await stored()), roles: [{ roleId: 'i', name: 'Implementer', model: 'claude-x', effort: 'low' as const, source: 'role' as const }] }
    expect(startLineup.override(s, { roles: [{ roleId: 'i', model: 'claude-x', effort: 'low' }], extraInstructions: '' }).roles[0]!.model).toBe('claude-x')
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
    expect(() => startLineup.override(s, input)).toThrow(ProposalInvalid)
    expect(() => startLineup.override(s, input)).toThrow(message)
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
    const o = startLineup.override(p, { roles: [{ roleId: 'i', model: 'opus', effort: 'high' }], extraInstructions: '' })
    await startLineup.execute(o, { workspaceId: ws.id, proposalId: 'p1' }, c)
    expect(c.startTicket).toHaveBeenCalledWith('t12', { roleIds: ['i'], roles: { i: { model: 'opus', effort: 'high' } } })
  })

  test('fails, starting nothing, when the ticket started meanwhile or the workspace closed', async () => {
    const c = ctx()
    const p = await propose({ ticket: 12 }, c)
    c.setWhy('#12 is already running')
    await expect(startLineup.execute(p, { workspaceId: ws.id, proposalId: 'p1' }, c)).rejects.toThrow('#12 is already running')
    c.setWhy(null)
    await expect(startLineup.execute(p, { workspaceId: 'other', proposalId: 'p1' }, c)).rejects.toThrow('no longer open')
    expect(c.startTicket).not.toHaveBeenCalled()
  })
})
