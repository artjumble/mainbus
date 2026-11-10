import { describe, expect, test } from 'vitest'
import { dictationReducer, formatElapsed, IDLE, insertTranscript, isSilent, type DictationEvent, type DictationState } from './dictation'

describe('insertTranscript', () => {
  test('puts the text at the caret, with a space between words', () => {
    expect(insertTranscript('Hello world', 5, 5, ' there')).toEqual({ value: 'Hello there world', caret: 11 })
  })

  test('goes into an empty field without a leading space', () => {
    expect(insertTranscript('', 0, 0, ' Hi there.')).toEqual({ value: 'Hi there.', caret: 9 })
  })

  test('goes at the start and at the end', () => {
    expect(insertTranscript('abc', 0, 0, 'one')).toEqual({ value: 'oneabc', caret: 3 })
    expect(insertTranscript('abc', 3, 3, 'one')).toEqual({ value: 'abc one', caret: 7 })
  })

  test('replaces the selection', () => {
    expect(insertTranscript('Fix the old bug now', 8, 11, 'new')).toEqual({ value: 'Fix the new bug now', caret: 11 })
    expect(insertTranscript('abc def', 3, 0, 'x')).toEqual({ value: 'x def', caret: 1 })
  })

  test('adds no space after whitespace or an opening bracket, or before punctuation', () => {
    expect(insertTranscript('Line one\n', 9, 9, 'Line two').value).toBe('Line one\nLine two')
    expect(insertTranscript('Call (', 6, 6, 'it').value).toBe('Call (it')
    expect(insertTranscript('Done', 4, 4, '. Next').value).toBe('Done. Next')
    expect(insertTranscript('Done', 4, 4, ', then').value).toBe('Done, then')
  })

  test('changes nothing for an empty transcript', () => {
    expect(insertTranscript('abc', 1, 2, '  ')).toEqual({ value: 'abc', caret: 2 })
    expect(insertTranscript('abc', 1, 1, '')).toEqual({ value: 'abc', caret: 1 })
  })

  test('clips the result to the field limit', () => {
    expect(insertTranscript('12345', 5, 5, 'abcdefgh', 10)).toEqual({ value: '12345 abcd', caret: 10 })
    expect(insertTranscript('1234567890', 10, 10, 'abc', 10)).toEqual({ value: '1234567890', caret: 10 })
  })
})

describe('isSilent', () => {
  test('is true for nothing and for near silence, false for speech-level audio', () => {
    expect(isSilent(new Float32Array(0))).toBe(true)
    expect(isSilent(new Float32Array(16000).fill(0.0005))).toBe(true)
    expect(isSilent(new Float32Array(16000).fill(0.05))).toBe(false)
  })
})

test('formatElapsed', () => {
  expect(formatElapsed(0)).toBe('0:00')
  expect(formatElapsed(7400)).toBe('0:07')
  expect(formatElapsed(125000)).toBe('2:05')
})

describe('dictationReducer', () => {
  const idle = IDLE
  const starting: DictationState = { kind: 'starting' }
  const recording: DictationState = { kind: 'recording' }
  const transcribing: DictationState = { kind: 'transcribing' }
  const error: DictationState = { kind: 'error', message: 'No microphone' }
  const failed: DictationEvent = { type: 'failed', message: 'boom' }

  test.each<[string, DictationState, DictationEvent, DictationState]>([
    ['idle starts', idle, { type: 'start' }, starting],
    ['an error can start again', error, { type: 'start' }, starting],
    ['starting becomes recording', starting, { type: 'started' }, recording],
    ['recording stops into transcribing', recording, { type: 'stop' }, transcribing],
    ['transcribing ends idle', transcribing, { type: 'transcribed' }, idle],
    ['cancel from starting', starting, { type: 'cancel' }, idle],
    ['cancel from recording', recording, { type: 'cancel' }, idle],
    ['cancel from transcribing', transcribing, { type: 'cancel' }, idle],
    ['failing while starting', starting, failed, { kind: 'error', message: 'boom' }],
    ['failing while recording', recording, failed, { kind: 'error', message: 'boom' }],
    ['failing while transcribing', transcribing, failed, { kind: 'error', message: 'boom' }],
    ['dismissing an error', error, { type: 'dismiss' }, idle]
  ])('%s', (_name, from, event, to) => {
    expect(dictationReducer(from, event)).toEqual(to)
  })

  test.each<[string, DictationState, DictationEvent]>([
    ['stop while idle', idle, { type: 'stop' }],
    ['stop while starting', starting, { type: 'stop' }],
    ['stop while transcribing', transcribing, { type: 'stop' }],
    ['start while recording', recording, { type: 'start' }],
    ['start while transcribing', transcribing, { type: 'start' }],
    ['started while idle', idle, { type: 'started' }],
    ['transcribed while recording', recording, { type: 'transcribed' }],
    ['cancel while idle', idle, { type: 'cancel' }],
    ['failed while idle', idle, failed],
    ['dismiss while recording', recording, { type: 'dismiss' }]
  ])('ignores %s', (_name, state, event) => {
    expect(dictationReducer(state, event)).toBe(state)
  })
})
