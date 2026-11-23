import { describe, expect, test, vi } from 'vitest'
import type { Ticket, Workspace } from '../../shared/domain'
import { ProposalInvalid, type ExecContext } from './kind'
import { setOwner } from './setOwner'

const ws = { id: 'ws1' } as Workspace
const TICKET = { id: 't12', number: 12, title: 'Check on a Mac', manualColumn: 'ready', owner: 'agent' } as Ticket
const turn = { userMessage: 'Mine', workspaceId: 'ws1' }

function ctx(over: { ticket?: Ticket | null; open?: boolean } = {}) {
  const ticket = over.ticket === undefined ? TICKET : over.ticket
  return {
    workspace: async () => ws,
    ticketByNumber: async (_w: string, n: number) => (n === 12 ? ticket : null),
    activeRole: async () => (over.open ? { id: 'r' } : null),
    setOwner: vi.fn(async (_id: string, owner: 'agent' | 'human') => ({ ...TICKET, owner }) as Ticket)
  } as unknown as ExecContext & { setOwner: ReturnType<typeof vi.fn> }
}

const propose = (input: unknown, c: ExecContext = ctx()) => Promise.resolve(setOwner.propose(input, turn, c))

describe('set_owner', () => {
  test('stores the ticket, the owner and the reason', async () => {
    expect(await propose({ ticket: 12, owner: 'human', reason: 'A hand check' })).toEqual({
      ticketId: 't12',
      number: 12,
      title: 'Check on a Mac',
      owner: 'human',
      reason: 'A hand check'
    })
  })

  test('is refused for a missing ticket, a Done ticket, the same owner, a run open, and no reason', async () => {
    await expect(propose({ ticket: 99, owner: 'human', reason: 'r' })).rejects.toThrow('there is no ticket #99')
    await expect(propose({ ticket: 12, owner: 'human', reason: 'r' }, ctx({ ticket: { ...TICKET, manualColumn: 'done' } }))).rejects.toThrow('is Done')
    await expect(propose({ ticket: 12, owner: 'agent', reason: 'r' })).rejects.toThrow('already belongs to agents')
    await expect(propose({ ticket: 12, owner: 'human', reason: 'r' }, ctx({ ticket: { ...TICKET, owner: 'human' } }))).rejects.toThrow('already belongs to the user')
    await expect(propose({ ticket: 12, owner: 'human', reason: 'r' }, ctx({ open: true }))).rejects.toThrow('has a run open')
    await expect(propose({ ticket: 12, owner: 'human', reason: ' ' })).rejects.toBeInstanceOf(ProposalInvalid)
  })

  test('confirming sets the owner both ways and says so', async () => {
    const c = ctx()
    const toHuman = await setOwner.execute(await propose({ ticket: 12, owner: 'human', reason: 'r' }), { workspaceId: 'ws1', proposalId: 'p1' }, c)
    expect(c.setOwner).toHaveBeenCalledWith('t12', 'human')
    expect(setOwner.outcome(toHuman)).toBe('Marked #12 "Check on a Mac" as the user\'s own.')
    const toAgent = await setOwner.execute({ ticketId: 't12', number: 12, title: 'Check on a Mac', owner: 'agent', reason: 'r' }, { workspaceId: 'ws1', proposalId: 'p1' }, c)
    expect(c.setOwner).toHaveBeenLastCalledWith('t12', 'agent')
    expect(setOwner.outcome(toAgent)).toBe('Handed #12 "Check on a Mac" to agents.')
  })

  test("execute fails with the engine's refusal if a run opened in between", async () => {
    const c = ctx()
    c.setOwner.mockRejectedValueOnce(new Error('#12 has a run open; stop it before changing who owns it'))
    await expect(setOwner.execute({ ticketId: 't12', number: 12, title: 'T', owner: 'human', reason: 'r' }, { workspaceId: 'ws1', proposalId: 'p1' }, c)).rejects.toThrow('has a run open')
  })
})
