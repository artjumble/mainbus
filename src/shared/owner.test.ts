import { expect, test } from 'vitest'
import { agentsMayAct, yoursText } from './owner'

test('agents may act on an agent-owned ticket and not on the users own', () => {
  expect(agentsMayAct({ owner: 'agent' })).toBe(true)
  expect(agentsMayAct({ owner: 'human' })).toBe(false)
})

test('every refusal uses one wording', () => {
  expect(yoursText(7)).toBe('#7 is yours; the user has to hand it to agents first')
})
