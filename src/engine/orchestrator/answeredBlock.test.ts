import { describe, expect, it } from 'vitest'
import type { Decision } from '../../shared/domain'
import { answeredBlock, ANSWERED_HEADING } from './answeredBlock'

const base: Decision = {
  id: 'd1',
  deferredUntil: null,
  ticketId: 't',
  agentRunId: 'r',
  kind: 'question',
  question: 'Which db?',
  options: ['sqlite', 'postgres'],
  recommended: null,
  allowAlways: true,
  status: 'answered',
  answer: { kind: 'option', index: 1, note: 'prod-ready' },
  createdAt: 'x',
  answeredAt: 'y',
  answeredBy: 'user',
  answeredVia: 'orchestrator'
}

describe('answeredBlock', () => {
  it('is null with nothing answered', () => {
    expect(answeredBlock([])).toBeNull()
  })

  it('lists each answer and where it came from', () => {
    const perm: Decision = { ...base, id: 'd2', kind: 'permission', question: 'Run rm?', answer: { kind: 'permission', choice: 'deny' }, answeredVia: 'board' }
    const block = answeredBlock([
      { number: 3, title: 'Login', decision: base },
      { number: 4, title: 'Logout', decision: perm }
    ])
    expect(block).toBe(
      [
        ANSWERED_HEADING,
        `- #3 "Login", asked "Which db?": the user chose "postgres" with the note "prod-ready" from the orchestrator panel. Don't propose an answer to it.`,
        `- #4 "Logout", asked "Run rm?": the user denied from the board. Don't propose an answer to it.`
      ].join('\n')
    )
  })
})
