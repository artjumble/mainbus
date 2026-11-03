import { describe, expect, it } from 'vitest'
import { ordinal, queuedLabel } from './queue'

describe('queue wording', () => {
  it.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [22, '22nd'],
    [101, '101st'],
    [111, '111th']
  ])('%i is %s', (n, text) => {
    expect(ordinal(n)).toBe(text)
  })

  it('labels a place, or none', () => {
    expect(queuedLabel(2)).toBe('Queued · 2nd')
    expect(queuedLabel(undefined)).toBe('Queued')
  })
})
