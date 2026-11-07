import { describe, expect, test } from 'vitest'
import { UNBLOCKED_HEADING, unblockedBlock } from './unblockedBlock'

describe('unblockedBlock', () => {
  test('is null when nothing was unblocked', () => {
    expect(unblockedBlock([])).toBeNull()
  })

  test('lists each ticket with the blockers that are Done', () => {
    expect(
      unblockedBlock([
        { number: 40, title: 'Login\nform', blockers: [{ number: 39, title: 'Schema' }] },
        { number: 41, title: 'Logout', workspace: 'shop', blockers: [{ number: 39, title: 'Schema' }, { number: 40, title: 'Login' }] }
      ])
    ).toBe(
      [
        UNBLOCKED_HEADING,
        '- #40 "Login form" is no longer blocked: #39 is Done. It can be started now.',
        '- #41 "Logout" (workspace "shop") is no longer blocked: #39, #40 are Done. It can be started now.'
      ].join('\n')
    )
  })
})
