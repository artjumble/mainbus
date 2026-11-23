import { describe, expect, test } from 'vitest'
import { createdText } from './session'

describe('createdText', () => {
  test("notes the tickets that are the user's own", () => {
    const text = createdText('shop', [{ number: 21, title: 'Mac run', owner: 'human' }, { number: 22, title: 'Fix' }])
    expect(text).toContain(`#21 "Mac run" (the user's own) and #22 "Fix" in shop's Backlog`)
  })
})
