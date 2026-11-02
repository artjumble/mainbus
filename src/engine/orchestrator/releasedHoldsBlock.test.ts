import { describe, expect, test } from 'vitest'
import { RELEASED_HEADING, releasedHoldsBlock } from './releasedHoldsBlock'

describe('releasedHoldsBlock', () => {
  test('is null when nothing was released', () => {
    expect(releasedHoldsBlock([])).toBeNull()
  })

  test('lists each ticket, and says when its date came', () => {
    const block = releasedHoldsBlock([
      { number: 4, title: 'Login', until: '2026-11-03T00:00:00.000Z', releasedAt: '2026-11-03T00:00:00.000Z' },
      { number: 5, title: 'Logout\nnow', until: '2026-11-20T00:00:00.000Z', releasedAt: '2026-11-03T08:00:00.000Z' },
      { number: 6, title: 'Signup', until: null, releasedAt: '2026-11-03T09:00:00.000Z' }
    ])
    expect(block).toBe(
      [
        RELEASED_HEADING,
        '- #4 "Login" is no longer held (its date, 2026-11-03, came). It can be started again.',
        '- #5 "Logout now" is no longer held. It can be started again.',
        '- #6 "Signup" is no longer held. It can be started again.'
      ].join('\n')
    )
  })
})
