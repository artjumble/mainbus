import { describe, expect, test, vi } from 'vitest'
import type { Decision, DecisionAnswer, Ticket } from '../../shared/domain'
import type { AnswerPayload } from '../../shared/proposals'
import { answer, choiceLabels, whyNotPending } from './answer'
import { ProposalInvalid, type ExecContext } from './kind'

const NOW = new Date('2026-11-02T09:00:00.000Z')
const TICKET = { id: 't3', number: 3, title: 'Add login', workspaceId: 'ws1' } as Ticket
const turn = { userMessage: 'Use Postgres', workspaceId: 'ws1' }

const QUESTION = {
  id: 'd1',
  ticketId: 't3',
  kind: 'question',
  question: 'Which database?',
  options: ['SQLite', 'Postgres', 'MySQL'],
  recommended: null,
  allowAlways: false,
  status: 'pending',
  deferredUntil: null,
  answeredVia: null
} as unknown as Decision
const PERMISSION = { ...QUESTION, id: 'd2', kind: 'permission', question: 'Run npm install?', options: [], allowAlways: true } as Decision

const JUDGEMENT = {
  reason: 'widens_intent',
  requirement: 'Add login',
  proposed: 'Also add SSO',
  smallest_option: 'Password login only',
  consequences: [
    { option: 'SQLite', consequence: 'Simple' },
    { option: 'Postgres', consequence: 'A server to run' }
  ],
  recommendation: 'Password login only'
}

function ctx(decision: Decision | null = QUESTION, over: { ticket?: Ticket } = {}) {
  return {
    orchestratorFolder: '/home/orchestrator',
    workspace: async () => null,
    createTickets: async () => [],
    lineup: async () => [],
    ticketByNumber: async () => null,
    whyNotStartable: async () => null,
    startTicket: async () => {},
    activeRole: async () => null,
    pauseTicket: async () => {},
    stopTicket: async () => {},
    skipTicket: async () => {},
    now: () => NOW,
    holdTicket: async () => ({}) as never,
    decision: vi.fn(async (id: string) => (decision && decision.id === id ? { decision, ticket: over.ticket ?? TICKET } : null)),
    openStuckEpisode: async () => null,
    redirectTicket: async () => {},
    replaceTicket: async () => {},
    whyNotPromotable: async () => null,
    draftPromotionSpec: async () => ({ spec: '', drafted: false }),
    promoteTicket: async () => { throw new Error('not expected') },
    answerDecision: vi.fn(async (_id: string, _a: DecisionAnswer) => {}),
    whyNotUpdatable: async () => null,
    freshnessOf: () => null,
    updateFromMain: async () => {}
  } satisfies ExecContext
}

const propose = (input: unknown, c: ExecContext = ctx()) => Promise.resolve(answer.propose(input, turn, c))
const target = { workspaceId: 'ws1', proposalId: 'p' }

describe('answer: propose', () => {
  test("takes a question's option by its number, stores it as an index, and copies the decision's own text", async () => {
    expect(await propose({ decision: 'd1', choice: 2, note: ' Per your message ' })).toEqual({
      decisionId: 'd1',
      ticketId: 't3',
      number: 3,
      title: 'Add login',
      question: 'Which database?',
      decisionKind: 'question',
      options: ['SQLite', 'Postgres', 'MySQL'],
      allowAlways: false,
      choice: 1,
      note: 'Per your message',
      judgement: null
    })
  })

  test("takes a permission request's choice", async () => {
    expect(await propose({ decision: 'd2', choice: 'always_allow' }, ctx(PERMISSION))).toMatchObject({ decisionKind: 'permission', choice: 'always_allow' })
  })

  test('validates the choice against the decision', async () => {
    await expect(propose({ decision: 'd1', choice: 0 })).rejects.toThrow('choice: must be one of the 3 options')
    await expect(propose({ decision: 'd1', choice: 4 })).rejects.toThrow('choice: must be one of the 3 options')
    await expect(propose({ decision: 'd1', choice: 'deny' })).rejects.toThrow(/^choice: must be one of/)
    await expect(propose({ decision: 'd2', choice: 1 }, ctx(PERMISSION))).rejects.toThrow(/permission request/)
    await expect(propose({ decision: 'd2', choice: 'always_allow' }, ctx({ ...PERMISSION, allowAlways: false }))).rejects.toThrow(/"Always allow" is not offered/)
  })

  test('refuses an unknown decision, one of another workspace, a missing choice and unknown fields', async () => {
    await expect(propose({ decision: 'nope', choice: 1 })).rejects.toThrow('decision: there is no decision nope')
    await expect(propose({ decision: 'd1', choice: 1 }, ctx(QUESTION, { ticket: { ...TICKET, workspaceId: 'other' } }))).rejects.toThrow(/there is no decision/)
    await expect(propose({ decision: 'd1' })).rejects.toThrow(/^choice: required/)
    await expect(propose({ decision: 'd1', choice: 1, extra: 1 })).rejects.toThrow('Unknown field: extra')
    await expect(propose({ decision: 'd1', choice: 1, judgement: { ...JUDGEMENT, reason: 'whim' } })).rejects.toThrow(ProposalInvalid)
    await expect(propose({ decision: 'd1', choice: 1, judgement: { ...JUDGEMENT, consequences: [] } })).rejects.toThrow(/^judgement\.consequences/)
  })

  test('refuses a decision that is no longer pending, saying why', async () => {
    const answered = { ...QUESTION, status: 'answered', answeredVia: 'board' } as Decision
    await expect(propose({ decision: 'd1', choice: 1 }, ctx(answered))).rejects.toThrow('Already answered from the board')
    const deferred = { ...QUESTION, status: 'deferred', deferredUntil: '2026-11-03T09:00:00.000Z' } as Decision
    await expect(propose({ decision: 'd1', choice: 1 }, ctx(deferred))).rejects.toThrow(/Deferred until /)
  })

  test('a judgement may leave the choice out, or recommend one', async () => {
    expect(await propose({ decision: 'd1', judgement: JUDGEMENT })).toMatchObject({ choice: null, judgement: JUDGEMENT })
    expect(await propose({ decision: 'd1', choice: 1, judgement: JUDGEMENT })).toMatchObject({ choice: 0, judgement: JUDGEMENT })
  })
})

describe('answer: override and execute', () => {
  const stored = (input: unknown = { decision: 'd1', choice: 2 }): Promise<AnswerPayload> => propose(input)

  test('an override picks another option and edits the note', async () => {
    expect(answer.override!(await stored(), { choice: 2, note: 'Use MySQL' })).toMatchObject({ choice: 2, note: 'Use MySQL', userChose: true })
    expect(answer.override!(await stored({ decision: 'd1', choice: 2, note: 'x' }), { choice: 0 })).toMatchObject({ choice: 0, note: null })
  })

  test('an override is validated against the options', async () => {
    const p = await stored()
    expect(() => answer.override!(p, { choice: 3 })).toThrow('choice: must be one of the 3 options')
    expect(() => answer.override!(p, { choice: 'deny' })).toThrow(ProposalInvalid)
    expect(() => answer.override!(p, { choice: 0, extra: 1 })).toThrow('Unknown field: extra')
  })

  test('confirming answers the decision once, through the shared path, with the note', async () => {
    const c = ctx()
    const result = await answer.execute(await stored({ decision: 'd1', choice: 2, note: 'Per your message' }), target, c)
    expect(c.answerDecision).toHaveBeenCalledTimes(1)
    expect(c.answerDecision).toHaveBeenCalledWith('d1', { kind: 'option', index: 1, note: 'Per your message' })
    expect(result).toMatchObject({ number: 3, answer: 'Postgres', note: 'Per your message' })
    expect(answer.outcome(result)).toContain('"Postgres"')
  })

  test('a permission is answered as a permission', async () => {
    const c = ctx(PERMISSION)
    const p = await Promise.resolve(answer.propose({ decision: 'd2', choice: 'deny' }, turn, c))
    await answer.execute(p, target, c)
    expect(c.answerDecision).toHaveBeenCalledWith('d2', { kind: 'permission', choice: 'deny' })
  })

  test('a decision answered elsewhere since fails cleanly and answers nothing', async () => {
    const p = await stored()
    const c = ctx({ ...QUESTION, status: 'answered', answeredVia: 'board' } as Decision)
    await expect(answer.execute(p, target, c)).rejects.toThrow('Already answered from the board')
    expect(c.answerDecision).not.toHaveBeenCalled()
  })

  test('a decision deferred since fails with the date', async () => {
    const p = await stored()
    const c = ctx({ ...QUESTION, status: 'deferred', deferredUntil: '2026-11-03T09:00:00.000Z' } as Decision)
    await expect(answer.execute(p, target, c)).rejects.toThrow(/^Deferred until /)
    expect(c.answerDecision).not.toHaveBeenCalled()
  })

  test('a judgement is only answered by the user choosing', async () => {
    const c = ctx()
    const p = await stored({ decision: 'd1', choice: 1, judgement: JUDGEMENT })
    await expect(answer.execute(p, target, c)).rejects.toThrow('This needs your own choice')
    expect(c.answerDecision).not.toHaveBeenCalled()
    await answer.execute(answer.override!(p, { choice: 0 }), target, c)
    expect(c.answerDecision).toHaveBeenCalledWith('d1', { kind: 'option', index: 0 })
  })
})

describe('answer: helpers', () => {
  test('whyNotPending names where it was answered', () => {
    expect(whyNotPending(QUESTION, NOW)).toBeNull()
    expect(whyNotPending({ ...QUESTION, status: 'answered', answeredVia: 'thread' } as Decision, NOW)).toBe('Already answered from the thread')
    expect(whyNotPending({ ...QUESTION, status: 'expired' } as Decision, NOW)).toBe('The decision is expired, not pending')
  })

  test('choiceLabels', () => {
    expect(choiceLabels(PERMISSION)).toEqual(['Allow once', 'Always allow', 'Deny'])
    expect(choiceLabels({ ...PERMISSION, allowAlways: false })).toEqual(['Allow once', 'Deny'])
  })
})
