import { z } from 'zod'

/** The rules for a ticket's fields, wherever a ticket comes from other than the user's own form. */

// CR, LF, NEL, and the line and paragraph separators (U+2028, U+2029).
const LINE_BREAK = /[\r\n\u0085\p{Zl}\p{Zp}]/u

export const text = (max: number) => z.string().min(1, 'must not be empty').max(max, `must be at most ${max} characters`)
export const nonBlank = (s: string) => s.trim() !== ''
export const singleLine = (s: string) => !LINE_BREAK.test(s)

export const ticketFields = {
  title: text(200).refine(nonBlank, 'must not be blank').refine(singleLine, 'must be a single line'),
  spec: z.string().max(100_000, 'must be at most 100000 characters'),
  criteria: z.array(text(1_000)).max(50, 'must have at most 50 items'),
  labels: z.array(text(50).refine(singleLine, 'must be a single line')).max(20, 'must have at most 20 items')
}
