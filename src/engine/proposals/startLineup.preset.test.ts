import { describe, expect, test, vi } from 'vitest'
import type { LineupRole, RunSettings, StartOptions, Ticket, Workspace } from '../../shared/domain'
import { testRole } from '../store/testDb'
import { ProposalInvalid, type ExecContext } from './kind'
import { startLineup } from './startLineup'

const ws = { id: 'ws1', name: 'repo' } as Workspace

const LINEUP: LineupRole[] = [
  testRole({ id: 'p', name: 'Planner', position: 1 }),
  testRole({ id: 'i', name: 'Implementer', position: 2 }),
  testRole({ id: 'r', name: 'Reviewer', position: 3 })
]
const TICKET = { id: 't12', number: 12, title: 'Rate-limit login', kind: 'change', runSettings: null } as Ticket
const DOCS = { excludedRoleIds: ['p', 'r'], roles: { i: { model: 'haiku', effort: 'low' as const } }, extraInstructions: 'Docs only.', roleNames: {} }

function ctx(settings: RunSettings = DOCS, ticket: Ticket = TICKET) {
  return {
    workspace: async () => ws,
    lineup: async () => LINEUP,
    presets: async () => [{ id: 'x', workspaceId: ws.id, name: 'Docs', settings }],
    ticketByNumber: async (_w: string, n: number) => (n === 12 ? ticket : null),
    whyNotStartable: async () => null,
    startTicket: vi.fn(async (_id: string, _opts: StartOptions) => {})
  } as unknown as ExecContext & { startTicket: ReturnType<typeof vi.fn> }
}

const turn = { userMessage: 'Start #12', workspaceId: ws.id }
const propose = (input: unknown, c: ExecContext = ctx()) => Promise.resolve(startLineup.propose(input, turn, c))

describe('start_lineup: preset', () => {
  test('decides the roles and their models for this start, as saved settings would, and shows on the card', async () => {
    const p = await propose({ ticket: 12, preset: ' docs ' })
    expect(p.roles).toEqual([{ roleId: 'i', name: 'Implementer', model: 'haiku', effort: 'low', source: 'user' }])
    expect(p.extraInstructions).toBe('Docs only.')
    expect(p.preset).toEqual({ name: 'Docs', notices: [] })
  })

  test('is not saved on the ticket: confirming starts with the roles on the card', async () => {
    const c = ctx()
    const p = await propose({ ticket: 12, preset: 'Docs' }, c)
    await startLineup.execute(p, { workspaceId: ws.id, proposalId: 'p' }, c)
    expect(c.startTicket).toHaveBeenCalledWith('t12', expect.objectContaining({ roleIds: ['i'], extraInstructions: 'Docs only.' }))
  })

  test('refuses an unknown name, naming the presets', async () => {
    await expect(propose({ ticket: 12, preset: 'Nope' })).rejects.toThrow('preset: there is no preset "Nope" in this workspace; its presets are Docs')
  })

  test('refuses it together with roles or extraInstructions', async () => {
    await expect(propose({ ticket: 12, preset: 'Docs', roles: [{ role: 'Planner' }] })).rejects.toThrow('leave out roles and extraInstructions')
    await expect(propose({ ticket: 12, preset: 'Docs', extraInstructions: 'x' })).rejects.toThrow(ProposalInvalid)
  })

  test('refuses it for a ticket that has saved run settings, or is an Investigate ticket', async () => {
    await expect(propose({ ticket: 12, preset: 'Docs' }, ctx(DOCS, { ...TICKET, runSettings: DOCS } as Ticket))).rejects.toThrow(
      "has saved run settings, which decide its roles; use update_ticket's preset"
    )
    await expect(propose({ ticket: 12, preset: 'Docs' }, ctx(DOCS, { ...TICKET, kind: 'investigate' } as Ticket))).rejects.toThrow('presets are for Change tickets')
  })

  test('Full leaves the whole lineup to run', async () => {
    const full = { excludedRoleIds: [], roles: {}, extraInstructions: null, roleNames: {} }
    expect((await propose({ ticket: 12, preset: 'Docs' }, ctx(full))).roles.map((r) => r.name)).toEqual(['Planner', 'Implementer', 'Reviewer'])
  })
})
