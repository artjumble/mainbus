import { describe, expect, test } from 'vitest'
import { blockedLabel, notDoneYetText, openBlockers } from './dependencies'

const b = (number: number, done = false) => ({ id: `t${number}`, number, title: `T${number}`, done })

describe('blocker words', () => {
  test('only the blockers that are not Done count, in number order', () => {
    expect(openBlockers([b(41), b(39), b(40, true)]).map((x) => x.number)).toEqual([39, 41])
    expect(openBlockers([b(1, true)])).toEqual([])
  })

  test('the chip lists a few blockers and counts the rest', () => {
    expect(blockedLabel([b(39)])).toBe('Blocked by #39')
    expect(blockedLabel([b(39), b(40)])).toBe('Blocked by #39 and #40')
    expect(blockedLabel([b(39), b(40), b(41)])).toBe('Blocked by #39, #40 and #41')
    expect(blockedLabel([b(1), b(2), b(3), b(4), b(5)])).toBe('Blocked by #1, #2, #3 +2')
  })

  test('the start question names what is not Done', () => {
    expect(notDoneYetText([b(39)])).toBe("#39 isn't Done yet")
    expect(notDoneYetText([b(39), b(40)])).toBe("#39 and #40 aren't Done yet")
  })
})
