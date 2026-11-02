import { describe, expect, test } from 'vitest'
import { dateInputValue, fromDateInput, holdLabel, nextMonday, tomorrow } from './hold'

// Local times, as the functions use: Wednesday 4 November 2026, 15:30.
const WED = new Date(2026, 10, 4, 15, 30)

describe('holdLabel', () => {
  test('is "Held by you" with no date', () => {
    expect(holdLabel({ until: null }, WED)).toBe('Held by you')
  })

  test('names the weekday for a date within the week', () => {
    expect(holdLabel({ until: new Date(2026, 10, 5).toISOString() }, WED)).toBe('Held until Thu')
    expect(holdLabel({ until: new Date(2026, 10, 10).toISOString() }, WED)).toBe('Held until Tue')
  })

  test('gives a short date from a week out', () => {
    expect(holdLabel({ until: new Date(2026, 10, 12).toISOString() }, WED)).toBe('Held until Nov 12')
    expect(holdLabel({ until: new Date(2027, 0, 3).toISOString() }, WED)).toBe('Held until Jan 3')
  })
})

describe('quick picks', () => {
  test('Tomorrow is the start of the next day', () => {
    expect(tomorrow(WED)).toEqual(new Date(2026, 10, 5))
    expect(tomorrow(new Date(2026, 11, 31, 23, 59))).toEqual(new Date(2027, 0, 1))
  })

  test('Monday is the next Monday, a week ahead when it is Monday', () => {
    expect(nextMonday(WED)).toEqual(new Date(2026, 10, 9))
    expect(nextMonday(new Date(2026, 10, 9, 8))).toEqual(new Date(2026, 10, 16))
    expect(nextMonday(new Date(2026, 10, 8))).toEqual(new Date(2026, 10, 9))
    expect(nextMonday(new Date(2026, 10, 7))).toEqual(new Date(2026, 10, 9))
  })
})

describe('date input values', () => {
  test('round-trip a local day', () => {
    expect(dateInputValue(new Date(2026, 10, 4, 15))).toBe('2026-11-04')
    expect(fromDateInput('2026-11-04')).toEqual(new Date(2026, 10, 4))
  })

  test('refuse what is not a date', () => {
    expect(fromDateInput('')).toBeNull()
    expect(fromDateInput('2026-13-01')).toBeNull()
    expect(fromDateInput('2026-02-30')).toBeNull()
    expect(fromDateInput('tomorrow')).toBeNull()
  })
})
