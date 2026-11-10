import { describe, expect, test, vi } from 'vitest'
import type { StuckEpisode, Ticket, Workspace } from '../../shared/domain'
import type { RedirectPayload } from '../../shared/proposals'
import { ProposalInvalid, type ActiveRole, type ExecContext } from './kind'
import { redirect } from './redirect'

const ws = { id: 'ws1' } as Workspace
const TICKET = { id: 't12', number: 12, title: 'Rate-limit login' } as Ticket
const ACTIVE: ActiveRole = { agentRunId: 'r1', role: 'Implementer', agentStatus: 'working', model: 'opus', effort: 'high', next: 'Reviewer' }
const EPISODE: StuckEpisode = {
  id: 'e1',
  agentRunId: 'r1',
  rule: 'repeated_failure',
  evidence: ['Bash failed 5 times in a row: npm test', 'Last error: timed out'],
  hitCount: 1,
  needsCloserLook: false,
  openedAt: '2026-11-02T09:00:00.000Z',
  lastHitAt: '2026-11-02T09:00:00.000Z',
  escalatedAt: null,
  redirectedAt: null
}
const turn = { userMessage: 'Why is #12 stuck?', workspaceId: 'ws1' }
const MESSAGE = 'Timeouts are ruled out; check the shared fixtures instead.'

function ctx(over: { active?: ActiveRole | null; episode?: StuckEpisode | null; open?: Workspace | null } = {}) {
  const c = {
    orchestratorFolder: '/home/orchestrator',
    workspace: async () => (over.open === undefined ? ws : over.open),
    createTickets: async () => [],
    lineup: async () => [],
    ticketByNumber: async (_w: string, n: number) => (n === 12 ? TICKET : null),
    whyNotStartable: async () => null,
    startTicket: async () => {},
    activeRole: async () => (over.active === undefined ? ACTIVE : over.active),
    pauseTicket: async () => {},
    stopTicket: async () => {},
    skipTicket: async () => {},
    now: () => new Date('2026-11-02T09:00:00.000Z'),
    holdTicket: async () => {
      throw new Error('unused')
    },
    openStuckEpisode: vi.fn(async () => (over.episode === undefined ? EPISODE : over.episode)),
    replaceTicket: async () => {},
    redirectTicket: vi.fn(async (_id: string, _expect: { agentRunId: string; episodeId: string }, _message: string) => {}),
    decision: async () => null,
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
  return c satisfies ExecContext
}

const propose = (input: unknown, c: ExecContext = ctx()) => Promise.resolve(redirect.propose(input, turn, c))
const PAYLOAD: RedirectPayload = {
  ticketId: 't12',
  number: 12,
  title: 'Rate-limit login',
  agentRunId: 'r1',
  episodeId: 'e1',
  role: 'Implementer',
  episodeEvidence: EPISODE.evidence,
  message: MESSAGE
}

describe('redirect: propose', () => {
  test('stores the episode, its evidence and the message', async () => {
    expect(await propose({ ticket: 12, message: `  ${MESSAGE} ` })).toEqual(PAYLOAD)
  })

  test('needs an open stuck episode', async () => {
    await expect(propose({ ticket: 12, message: MESSAGE }, ctx({ episode: null }))).rejects.toThrow(/no open stuck episode/)
    await expect(propose({ ticket: 12, message: MESSAGE }, ctx({ active: null }))).rejects.toThrow(/no active role/)
    await expect(propose({ ticket: 99, message: MESSAGE })).rejects.toThrow(/there is no ticket #99/)
  })

  test('refuses an episode already redirected, and says to propose a replacement', async () => {
    const redirected = { ...EPISODE, redirectedAt: '2026-11-02T09:10:00.000Z' }
    await expect(propose({ ticket: 12, message: MESSAGE }, ctx({ episode: redirected }))).rejects.toThrow(
      /already been redirected once; propose a replacement instead/
    )
  })

  test('needs a message, and no other fields', async () => {
    await expect(propose({ ticket: 12 })).rejects.toBeInstanceOf(ProposalInvalid)
    await expect(propose({ ticket: 12, message: '   ' })).rejects.toThrow(/message: required/)
    await expect(propose({ ticket: 12, message: 'x'.repeat(2_001) })).rejects.toThrow(/message: must be at most 2000/)
    await expect(propose({ ticket: 12, message: MESSAGE, episodeId: 'e9' })).rejects.toThrow(/Unknown field: episodeId/)
  })
})

describe('redirect: override', () => {
  test('edits the message and keeps the engine fields', () => {
    expect(redirect.override!(PAYLOAD, { message: ' Look at test/shared. ' })).toEqual({ ...PAYLOAD, message: 'Look at test/shared.' })
  })

  test('refuses an empty message or other fields', () => {
    expect(() => redirect.override!(PAYLOAD, { message: '' })).toThrow(ProposalInvalid)
    expect(() => redirect.override!(PAYLOAD, { message: 'x', episodeId: 'e2' })).toThrow(/Unknown field: episodeId/)
  })
})

describe('redirect: execute', () => {
  const target = { workspaceId: 'ws1', proposalId: 'p1' }

  test('interrupts through the engine with the message and the episode', async () => {
    const c = ctx()
    expect(await redirect.execute(PAYLOAD, target, c)).toEqual({ ticketId: 't12', number: 12, title: 'Rate-limit login', role: 'Implementer', message: MESSAGE })
    expect(c.redirectTicket).toHaveBeenCalledWith('t12', { agentRunId: 'r1', episodeId: 'e1' }, MESSAGE, 'p1')
  })

  test.each([
    ['the run moved on to another role', { active: { ...ACTIVE, agentRunId: 'r2' } }, /moved on/],
    ['the run ended', { active: null }, /the run has ended/],
    ['the episode closed', { episode: null }, /no longer stuck/],
    ['a newer episode opened', { episode: { ...EPISODE, id: 'e2' } }, /no longer stuck/],
    ['it was already redirected', { episode: { ...EPISODE, redirectedAt: '2026-11-02T09:10:00.000Z' } }, /already been redirected/],
    ['the role is paused', { active: { ...ACTIVE, agentStatus: 'paused' as const } }, /not working now/]
  ])('fails, interrupting nothing, when %s', async (_name, over, why) => {
    const c = ctx(over)
    await expect(redirect.execute(PAYLOAD, target, c)).rejects.toThrow(why)
    await expect(redirect.execute(PAYLOAD, target, c)).rejects.toThrow(/Nothing was interrupted/)
    expect(c.redirectTicket).not.toHaveBeenCalled()
  })

  test('fails when the workspace is was removed', async () => {
    const c = ctx({ open: null })
    await expect(redirect.execute(PAYLOAD, target, c)).rejects.toThrow(/was removed/)
    expect(c.redirectTicket).not.toHaveBeenCalled()
  })
})

test('outcome tells the orchestrator what the agent got, and what comes next', () => {
  const text = redirect.outcome({ ticketId: 't12', number: 12, title: 'Rate-limit login', role: 'Implementer', message: MESSAGE })
  expect(text).toContain('Redirected the Implementer on #12')
  expect(text).toContain(JSON.stringify(MESSAGE))
  expect(text).toContain('propose a replacement')
})
