import { describe, expect, test, vi } from 'vitest'
import type { BranchFreshness, Ticket, Workspace } from '../../shared/domain'
import { ProposalInvalid, type ExecContext } from './kind'
import { updateFromMain } from './updateFromMain'

const ws = { id: 'ws1' } as Workspace
const TICKET = { id: 't4', number: 4, title: 'Add a migration' } as Ticket
const FRESH: BranchFreshness = { baseBranch: 'main', base: 'origin/main', behind: 3, conflicts: ['migrations/journal.txt'], checkedAt: '', fetchError: null }
const turn = { userMessage: 'Update #4', workspaceId: 'ws1' }

function ctx(over: { open?: Workspace | null; why?: string | null; fresh?: BranchFreshness | null; active?: { agentRunId: string; role: string } | null } = {}) {
  return {
    orchestratorFolder: '/home/orchestrator',
    workspace: async () => (over.open === undefined ? ws : over.open),
    createTickets: async () => [],
    lineup: async () => [],
    ticketByNumber: async (_w: string, n: number) => (n === 4 ? TICKET : null),
    whyNotStartable: async () => null,
    startTicket: async () => {},
    activeRole: async () => (over.active ? ({ ...over.active, agentStatus: 'paused', model: 'm', effort: 'high', next: null } as never) : null),
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
    whyNotPromotable: async () => null,
    draftPromotionSpec: async () => ({ spec: '', drafted: false }),
    promoteTicket: async () => {
      throw new Error('not expected')
    },
    answerDecision: async () => {},
    whyNotUpdatable: vi.fn(async () => (over.why === undefined ? null : over.why)),
    freshnessOf: vi.fn(() => (over.fresh === undefined ? FRESH : over.fresh)),
    updateFromMain: vi.fn(async () => {})
  } satisfies ExecContext
}

const propose = (input: unknown, c: ExecContext = ctx()) => Promise.resolve(updateFromMain.propose(input, turn, c))
const target = { workspaceId: 'ws1', proposalId: 'p1' }

describe('update_from_main: propose', () => {
  test('copies how far behind the ticket is and the conflicting files, with no run when none is open', async () => {
    expect(await propose({ ticket: 4 })).toEqual({
      ticketId: 't4',
      number: 4,
      title: 'Add a migration',
      base: 'main',
      behind: 3,
      conflicts: ['migrations/journal.txt'],
      agentRunId: null,
      role: null
    })
  })

  test('names the paused or waiting run that the update would end', async () => {
    expect(await propose({ ticket: 4 }, ctx({ active: { agentRunId: 'r9', role: 'Implementer' } }))).toMatchObject({ agentRunId: 'r9', role: 'Implementer' })
  })

  test('refuses what is wrong, naming the field or the reason', async () => {
    await expect(propose({})).rejects.toThrow(/^ticket: /)
    await expect(propose({ ticket: 99 })).rejects.toThrow('ticket: there is no ticket #99')
    await expect(propose({ ticket: 4, extra: 1 })).rejects.toThrow('Unknown field: extra')
    await expect(propose({ ticket: 4 }, ctx({ why: 'A role is working on #4' }))).rejects.toThrow('ticket: A role is working on #4')
    await expect(propose({ ticket: 4 }, ctx({ why: 'x' }))).rejects.toThrow(ProposalInvalid)
    await expect(propose({ ticket: 4 }, ctx({ fresh: null }))).rejects.toThrow(/not known to be behind/)
  })
})

describe('update_from_main: execute', () => {
  const payload = { ticketId: 't4', number: 4, title: 'Add a migration', base: 'main', behind: 3, conflicts: ['a'], agentRunId: 'r9', role: 'Implementer' }

  test('starts the update, expecting the run the user saw', async () => {
    const c = ctx()
    const result = await updateFromMain.execute(payload, target, c)
    expect(c.updateFromMain).toHaveBeenCalledWith('t4', { agentRunId: 'r9' })
    expect(result).toMatchObject({ ticketId: 't4', number: 4, base: 'main' })
    expect(updateFromMain.outcome(result)).toMatch(/^Started an Update on #4 "Add a migration"/)
  })

  test('expects no open run when none was open', async () => {
    const c = ctx()
    await updateFromMain.execute({ ...payload, agentRunId: null, role: null }, target, c)
    expect(c.updateFromMain).toHaveBeenCalledWith('t4', null)
  })

  test('fails when the workspace is gone or the ticket changed, and passes on the engine refusing', async () => {
    await expect(updateFromMain.execute(payload, target, ctx({ open: null }))).rejects.toThrow(/workspace/)
    await expect(updateFromMain.execute({ ...payload, ticketId: 'other' }, target, ctx())).rejects.toThrow(/no longer exists/)
    const c = ctx()
    c.updateFromMain.mockRejectedValueOnce(new Error('The ticket has moved on'))
    await expect(updateFromMain.execute(payload, target, c)).rejects.toThrow('moved on')
  })
})
