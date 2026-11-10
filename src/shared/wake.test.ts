import { expect, test } from 'vitest'
import { wakeEventText } from './wake'
import { doneReviewedText } from './doneReview'

test('says how many things to look at, as before', () => {
  expect(wakeEventText(['a'])).toBe('Mainbus: 1 thing to look at')
  expect(wakeEventText(['a', 'b'])).toBe('Mainbus: 2 things to look at')
})

test('says when it is reviewing finished tickets, alone or with other things', () => {
  expect(wakeEventText(['a', 'b'], 2)).toBe('Mainbus: reviewing 2 finished tickets')
  expect(wakeEventText(['a'], 1)).toBe('Mainbus: reviewing 1 finished ticket')
  expect(wakeEventText(['a', 'b', 'c'], 2)).toBe('Mainbus: 1 thing to look at, and reviewing 2 finished tickets')
})

test("tells a review's result for the ticket's Activity", () => {
  expect(doneReviewedText(0)).toBe('Reviewed by the orchestrator: no follow-ups proposed')
  expect(doneReviewedText(1)).toBe('Reviewed by the orchestrator: 1 follow-up proposed')
  expect(doneReviewedText(3)).toBe('Reviewed by the orchestrator: 3 follow-ups proposed')
})
