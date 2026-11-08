import { describe, expect, it } from 'vitest'
import { activeMention, findMentions, mentionText } from './mentions'

describe('findMentions', () => {
  it('finds tokens at a word start only', () => {
    expect(findMentions('a@b and @hunter').map((m) => m.raw)).toEqual(['@hunter'])
    expect(findMentions('@a\n@b').map((m) => m.name)).toEqual(['a', 'b'])
  })
  it('reads quoted names and trims trailing punctuation', () => {
    const [q, p] = findMentions('in @"my app", then @hunter.')
    expect(q).toMatchObject({ raw: '@"my app"', name: 'my app', quoted: true })
    expect(p).toMatchObject({ raw: '@hunter', name: 'hunter', quoted: false })
  })
  it('ignores a lone @ and an unclosed quote', () => {
    expect(findMentions('@ hi @"oops')).toEqual([])
  })
})

describe('mentionText', () => {
  it('quotes names that would end the token', () => {
    expect(mentionText('hunter')).toBe('@hunter')
    expect(mentionText('my app')).toBe('@"my app"')
    expect(mentionText('v1.')).toBe('@"v1."')
  })
})

describe('activeMention', () => {
  it('finds the token before the caret', () => {
    expect(activeMention('@hu', 3)).toEqual({ start: 0, query: 'hu' })
    expect(activeMention('go @hu', 6)).toEqual({ start: 3, query: 'hu' })
    expect(activeMention('go\n@', 4)).toEqual({ start: 3, query: '' })
    expect(activeMention('@"my a', 6)).toEqual({ start: 0, query: 'my a' })
  })
  it('is null in an address, after a newline, or without the @', () => {
    expect(activeMention('a@b', 3)).toBeNull()
    expect(activeMention('@a\nb', 4)).toBeNull()
    expect(activeMention('hu', 2)).toBeNull()
  })
})
