import { describe, expect, test } from 'vitest'
import { dateInputValue, deferredLabel, fromDateInput, holdLabel, laterMonday, laterTomorrow, nextMonday, tomorrow, waitingLabel } from './hold'

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

describe('Later… picks and labels', () => {
  test('Tomorrow and Monday are at 09:00 local', () => {
    expect(laterTomorrow(WED)).toEqual(new Date(2026, 10, 5, 9, 0))
    expect(laterMonday(WED)).toEqual(new Date(2026, 10, 9, 9, 0))
    // On a Monday, Monday is a week ahead.
    expect(laterMonday(new Date(2026, 10, 9, 20, 0))).toEqual(new Date(2026, 10, 16, 9, 0))
  })

  test('the deferred and waiting labels name the day', () => {
    const until = new Date(2026, 10, 5, 9).toISOString()
    expect(deferredLabel(until, WED)).toBe('Deferred until Thu')
    expect(waitingLabel(until, WED)).toBe('Waiting on you · until Thu')
    expect(waitingLabel(new Date(2026, 10, 20, 9).toISOString(), WED)).toBe('Waiting on you · until Nov 20')
  })
})
