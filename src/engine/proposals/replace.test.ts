import { describe, expect, test, vi } from 'vitest'
import type { StuckEpisode, Ticket, Workspace } from '../../shared/domain'
import type { ReplacePayload } from '../../shared/proposals'
import { ProposalInvalid, type ActiveRole, type ExecContext, type Turn } from './kind'
import { replace } from './replace'

const ws = { id: 'ws1' } as Workspace
const TICKET = { id: 't12', number: 12, title: 'Rate-limit login' } as Ticket
const ACTIVE: ActiveRole = { agentRunId: 'r1', role: 'Implementer', agentStatus: 'working', model: 'opus', effort: 'high', next: 'Reviewer' }
/** Redirected at 09:10 and hit again at 09:20: the redirect did not help. */
const FIRED_AGAIN: StuckEpisode = {
  id: 'e1',
  agentRunId: 'r1',
  rule: 'repeated_failure',
  evidence: ['Bash failed 5 times in a row: npm test', 'Last error: timed out'],
  hitCount: 2,
  needsCloserLook: false,
  openedAt: '2026-11-02T09:00:00.000Z',
  lastHitAt: '2026-11-02T09:20:00.000Z',
  escalatedAt: null,
  redirectedAt: '2026-11-02T09:10:00.000Z'
}
const turn: Turn = { userMessage: 'Why is #12 stuck?', workspaceId: 'ws1' }
const BUTTON: Turn = { userMessage: null, workspaceId: 'ws1', origin: 'button' }
const INPUT = { ticket: 12, reason: 'A fresh agent will not repeat the same dead end' }

function ctx(over: { active?: ActiveRole | null; episode?: StuckEpisode | null; open?: Workspace | null } = {}) {
  const c = {
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
    now: () => new Date('2026-11-02T09:30:00.000Z'),
    holdTicket: async () => {
      throw new Error('unused')
    },
    openStuckEpisode: vi.fn(async () => (over.episode === undefined ? FIRED_AGAIN : over.episode)),
    redirectTicket: async () => {},
    replaceTicket: vi.fn(
      async (_id: string, _expect: { agentRunId: string }, _request: { model: string; effort: string; extraInstructions: string | null }) => {}
    ),
    decision: async () => null,
    whyNotPromotable: async () => null,
    draftPromotionSpec: async () => ({ spec: '', drafted: false }),
    promoteTicket: async () => { throw new Error('not expected') },
    answerDecision: async () => {}
  }
  return c satisfies ExecContext
}

const propose = (input: unknown, c: ExecContext = ctx(), t = turn) => Promise.resolve(replace.propose(input, t, c))
const PAYLOAD: ReplacePayload = {
  ticketId: 't12',
  number: 12,
  title: 'Rate-limit login',
  agentRunId: 'r1',
  role: 'Implementer',
  episodeId: 'e1',
  episodeEvidence: FIRED_AGAIN.evidence,
  reason: INPUT.reason,
  model: 'opus',
  effort: 'high',
  extraInstructions: null
}

test('is a kind of proposal that needs evidence', () => {
  expect(replace.evidenceRequired).toBe(true)
  expect(replace.override).toBeDefined()
})

describe('replace: propose by the orchestrator', () => {
  test('stores the episode, its evidence and the current agent’s model and effort', async () => {
    expect(await propose({ ...INPUT, reason: `  ${INPUT.reason} ` })).toEqual(PAYLOAD)
  })

  test('is valid only after a redirected episode fires again', async () => {
    await expect(propose(INPUT, ctx({ episode: null }))).rejects.toThrow(/no open stuck episode/)
    const unredirected = { ...FIRED_AGAIN, redirectedAt: null }
    await expect(propose(INPUT, ctx({ episode: unredirected }))).rejects.toThrow(/has not been redirected yet; propose a redirect first/)
    // Redirected, but not hit since.
    const quiet = { ...FIRED_AGAIN, lastHitAt: '2026-11-02T09:05:00.000Z' }
    await expect(propose(INPUT, ctx({ episode: quiet }))).rejects.toThrow(/has not fired again since/)
    await expect(propose(INPUT, ctx({ active: null }))).rejects.toThrow(/no active role/)
    await expect(propose({ ...INPUT, ticket: 99 })).rejects.toThrow(/there is no ticket #99/)
  })

  test('needs a reason, and no other fields', async () => {
    await expect(propose({ ticket: 12 })).rejects.toBeInstanceOf(ProposalInvalid)
    await expect(propose({ ticket: 12, reason: '  ' })).rejects.toThrow(/reason: required/)
    await expect(propose({ ...INPUT, model: 'haiku' })).rejects.toThrow(/Unknown field: model/)
  })
})

describe('replace: propose by the Replace… button', () => {
  test('works with no stuck episode', async () => {
    const c = ctx({ episode: null })
    expect(await propose(INPUT, c, BUTTON)).toEqual({ ...PAYLOAD, episodeId: null, episodeEvidence: [] })
    expect(c.openStuckEpisode).not.toHaveBeenCalled()
  })

  test('works for an episode not yet redirected, and ignores it', async () => {
    const payload = await propose(INPUT, ctx({ episode: { ...FIRED_AGAIN, redirectedAt: null } }), BUTTON)
    expect(payload).toMatchObject({ episodeId: null, episodeEvidence: [] })
  })

  test('still needs a role to replace', async () => {
    await expect(propose(INPUT, ctx({ active: null }), BUTTON)).rejects.toThrow(/no active role/)
  })
})

describe('replace: override', () => {
  test('changes the new run’s model, effort and extra instructions, and keeps the engine fields', () => {
    expect(replace.override!(PAYLOAD, { model: 'sonnet', effort: 'medium', extraInstructions: '  Look at test/shared first. ' })).toEqual({
      ...PAYLOAD,
      model: 'sonnet',
      effort: 'medium',
      extraInstructions: 'Look at test/shared first.'
    })
  })

  test('blank extra instructions are none', () => {
    expect(replace.override!({ ...PAYLOAD, extraInstructions: 'x' }, { model: 'opus', effort: 'high', extraInstructions: '  ' }).extraInstructions).toBeNull()
    expect(replace.override!(PAYLOAD, { model: 'opus', effort: 'high' }).extraInstructions).toBeNull()
  })

  test('accepts the role’s own model alias, refuses an unknown one, and refuses other fields', () => {
    const own = { ...PAYLOAD, model: 'claude-opus-4-7' }
    expect(replace.override!(own, { model: 'claude-opus-4-7', effort: 'high', extraInstructions: '' }).model).toBe('claude-opus-4-7')
    expect(() => replace.override!(PAYLOAD, { model: 'gpt', effort: 'high', extraInstructions: '' })).toThrow(/unknown model/)
    expect(() => replace.override!(PAYLOAD, { model: 'opus', effort: 'huge', extraInstructions: '' })).toThrow(ProposalInvalid)
    expect(() => replace.override!(PAYLOAD, { model: 'opus', effort: 'high', agentRunId: 'r2' })).toThrow(/Unknown field: agentRunId/)
  })
})

describe('replace: execute', () => {
  const target = { workspaceId: 'ws1', proposalId: 'p1' }

  test('replaces through the engine with the card’s model, effort and instructions', async () => {
    const c = ctx()
    const p = { ...PAYLOAD, model: 'haiku', effort: 'low' as const, extraInstructions: 'Be careful' }
    expect(await replace.execute(p, target, c)).toEqual({ ticketId: 't12', number: 12, title: 'Rate-limit login', role: 'Implementer', model: 'haiku', effort: 'low' })
    expect(c.replaceTicket).toHaveBeenCalledWith('t12', { agentRunId: 'r1' }, { model: 'haiku', effort: 'low', extraInstructions: 'Be careful', proposalId: 'p1', suggestedBy: 'orchestrator' })
    // A proposal with no episode is the user's own Replace… button.
    const button = ctx({ episode: null })
    await replace.execute({ ...p, episodeId: null }, target, button)
    expect(button.replaceTicket).toHaveBeenCalledWith('t12', { agentRunId: 'r1' }, expect.objectContaining({ proposalId: 'p1', suggestedBy: 'user' }))
  })

  test('the button’s proposal needs no episode to still be open', async () => {
    const c = ctx({ episode: null })
    await replace.execute({ ...PAYLOAD, episodeId: null, episodeEvidence: [] }, target, c)
    expect(c.replaceTicket).toHaveBeenCalledTimes(1)
  })

  test.each([
    ['the run moved on to another role', { active: { ...ACTIVE, agentRunId: 'r2' } }, /moved on/],
    ['the run ended', { active: null }, /the run has ended/],
    ['the episode closed', { episode: null }, /no longer stuck/],
    ['a newer episode opened', { episode: { ...FIRED_AGAIN, id: 'e2' } }, /no longer stuck/]
  ])('fails, replacing nothing, when %s', async (_name, over, why) => {
    const c = ctx(over)
    await expect(replace.execute(PAYLOAD, target, c)).rejects.toThrow(why)
    await expect(replace.execute(PAYLOAD, target, c)).rejects.toThrow(/Nothing was replaced/)
    expect(c.replaceTicket).not.toHaveBeenCalled()
  })

  test('fails when the workspace is no longer open', async () => {
    const c = ctx({ open: null })
    await expect(replace.execute(PAYLOAD, target, c)).rejects.toThrow(/no longer open/)
    expect(c.replaceTicket).not.toHaveBeenCalled()
  })
})

test('outcome tells the orchestrator what happened', () => {
  const text = replace.outcome({ ticketId: 't12', number: 12, title: 'Rate-limit login', role: 'Implementer', model: 'haiku', effort: 'low' })
  expect(text).toContain('Replaced the Implementer on #12')
  expect(text).toContain('haiku')
})
