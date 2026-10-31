import type { StoredEvent } from '../../../shared/events'
import { makeEvent } from '../test-utils'
import { mergeEvent } from './merge'

const partial = (text: string): StoredEvent => makeEvent({ kind: 'message', text, partial: true }, { seq: 0 })
const merge = (events: StoredEvent[]): StoredEvent[] => events.reduce<StoredEvent[]>(mergeEvent, [])

test('a later partial replaces the earlier one', () => {
  const merged = merge([partial('Hel'), partial('Hello')])
  expect(merged).toHaveLength(1)
  expect(merged[0]?.event).toMatchObject({ kind: 'message', text: 'Hello' })
})

test('partial messages are replaced by the final message, not duplicated', () => {
  const final = makeEvent({ kind: 'message', text: 'Hello there' })
  const merged = merge([partial('Hel'), partial('Hello'), final])
  expect(merged).toEqual([final])
})

test('a thinking partial is replaced by its final stub', () => {
  const live = makeEvent({ kind: 'thinking', text: null, partial: true }, { seq: 0 })
  const stub = makeEvent({ kind: 'thinking', text: null, durationMs: 4200 })
  expect(merge([live, stub])).toEqual([stub])
})

test('a message partial survives a thinking final', () => {
  const live = partial('Typing')
  const stub = makeEvent({ kind: 'thinking', text: null, durationMs: 1000 })
  expect(merge([live, stub])).toEqual([live, stub])
})

test('a stored event delivered twice appears once', () => {
  const call = makeEvent({ kind: 'tool_call', id: 'c1', name: 'Bash', input: {} })
  expect(merge([call, call])).toEqual([call])
})

test('the end of a turn or run clears leftover partials', () => {
  const end = makeEvent({ kind: 'turn_end', ok: true })
  expect(merge([partial('cut off'), end])).toEqual([end])
})

test('partials of another run are untouched', () => {
  const other = makeEvent({ kind: 'message', text: 'x', partial: true }, { seq: 0, runId: 'r2' })
  const final = makeEvent({ kind: 'message', text: 'done' })
  expect(merge([other, final])).toEqual([other, final])
})
