import { describe, expect, test } from 'vitest'
import { RESURFACED_HEADING, resurfacedBlock } from './resurfacedBlock'

describe('resurfacedBlock', () => {
  test('is null when nothing came back', () => {
    expect(resurfacedBlock([])).toBeNull()
  })

  test('lists each decision with its ticket, question and original date', () => {
    const block = resurfacedBlock([
      { number: 4, title: 'Login', question: 'Which\nAPI?', until: '2026-11-03T09:00:00.000Z' },
      { number: 5, title: 'Logout', question: 'Keep it?', until: '2026-11-04T09:00:00.000Z' }
    ])
    expect(block).toBe(
      [
        RESURFACED_HEADING,
        '- #4 "Login": "Which API?" (deferred until 2026-11-03) is waiting on the user again.',
        '- #5 "Logout": "Keep it?" (deferred until 2026-11-04) is waiting on the user again.'
      ].join('\n')
    )
  })
})
