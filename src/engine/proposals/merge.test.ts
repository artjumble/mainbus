import { describe, expect, test, vi } from 'vitest'
import type { Ticket, Workspace } from '../../shared/domain'
import type { MergeOutcome, MergePlan, MergePreview } from '../../shared/merge'
import { ProposalInvalid, type ExecContext } from './kind'
import { merge } from './merge'

const ws = { id: 'ws1' } as Workspace
const TICKET = { id: 't4', number: 4, title: 'Add login' } as Ticket
const PLAN: MergePlan = { kind: 'local', base: 'main', branch: 'mainbus/4-add', head: 'abc', how: 'fast_forward', commits: 2, checkout: '/repo', currentBranch: 'main', message: null }
const turn = { userMessage: 'What is next?', workspaceId: 'ws1' }

function ctx(over: { open?: Workspace | null; preview?: MergePreview; outcome?: Partial<MergeOutcome> } = {}) {
  return {
    orchestratorFolder: '/home/orchestrator',
    workspace: async () => (over.open === undefined ? ws : over.open),
    createTickets: async () => [],
    lineup: async () => [],
    ticketByNumber: async (_w: string, n: number) => (n === 4 ? TICKET : null),
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
    whyNotPromotable: async () => null,
    draftPromotionSpec: async () => ({ spec: '', drafted: false }),
    promoteTicket: async () => {
      throw new Error('not expected')
    },
    answerDecision: async () => {},
    whyNotUpdatable: async () => null,
    freshnessOf: () => null,
    updateFromMain: async () => {},
    mergePreview: vi.fn(async (): Promise<MergePreview> => over.preview ?? { ok: true, plan: PLAN }),
    mergeTicket: vi.fn(async (): Promise<MergeOutcome> => ({ plan: PLAN, commit: 'def', moved: 'moved', fetchError: null, ...over.outcome }))
  } satisfies ExecContext
}

const propose = (input: unknown, c: ExecContext = ctx()) => Promise.resolve(merge.propose(input, turn, c))
const target = { workspaceId: 'ws1', proposalId: 'p1' }

describe('merge: propose', () => {
  test('stores exactly the plan the user will see, with the defaults of Merge…', async () => {
    expect(await propose({ ticket: 4 })).toEqual({
      ticketId: 't4',
      number: 4,
      title: 'Add login',
      plan: PLAN,
      moveToDone: true,
      deleteBranch: false
    })
  })

  test('is refused with the reason and what to do when merging is not possible', async () => {
    const preview: MergePreview = { ok: false, reason: 'Your checkout (/repo) has uncommitted changes: a.txt', suggest: 'commit_or_stash' }
    await expect(propose({ ticket: 4 }, ctx({ preview }))).rejects.toThrow(
      'ticket: Your checkout (/repo) has uncommitted changes: a.txt. Commit or stash your changes, then try again.'
    )
    await expect(propose({ ticket: 4 }, ctx({ preview }))).rejects.toThrow(ProposalInvalid)
  })

  test('refuses what is wrong, naming the field', async () => {
    await expect(propose({})).rejects.toThrow(/^ticket: /)
    await expect(propose({ ticket: 99 })).rejects.toThrow('ticket: there is no ticket #99')
    await expect(propose({ ticket: 4, method: 'squash' })).rejects.toThrow('Unknown field: method')
  })

  test('has no override, so the user can only confirm or reject what the card says', () => {
    expect(merge.override).toBeUndefined()
  })
})

describe('merge: execute', () => {
  const payload = { ticketId: 't4', number: 4, title: 'Add login', plan: PLAN, moveToDone: true, deleteBranch: false }

  test('merges through the same path as the ticket view, expecting the plan the card showed', async () => {
    const c = ctx()
    const result = await merge.execute(payload, target, c)
    expect(c.mergeTicket).toHaveBeenCalledWith('t4', { expect: PLAN, moveToDone: true, deleteBranch: false, proposalId: 'p1' })
    expect(result).toMatchObject({ ticketId: 't4', number: 4, moved: 'moved', commit: 'def' })
    expect(merge.outcome(result)).toMatch(/^Merged #4 "Add login": Fast-forwards main to mainbus\/4-add.* #4 is in Done\.$/)
  })

  test('tells the orchestrator when the ticket could not move to Done', async () => {
    const result = await merge.execute(payload, target, ctx({ outcome: { moved: 'dirty' } }))
    expect(merge.outcome(result)).toContain('could not move to Done and is still in Review')
  })

  test('fails when the workspace is gone or the ticket changed, and passes on the engine refusing', async () => {
    await expect(merge.execute(payload, target, ctx({ open: null }))).rejects.toThrow(/workspace/)
    await expect(merge.execute({ ...payload, ticketId: 'other' }, target, ctx())).rejects.toThrow(/no longer exists/)
    const c = ctx()
    c.mergeTicket.mockRejectedValueOnce(new Error('Something changed since you looked at this'))
    await expect(merge.execute(payload, target, c)).rejects.toThrow('Something changed')
  })
})
