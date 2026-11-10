// The pure parts of dictation: where the transcript goes in the field, and the states a dictation moves through.

/** A recording stops by itself after this long. */
export const MAX_RECORDING_MS = 5 * 60 * 1000

/**
 * The field's text with `transcript` in place of the selection `selStart` to `selEnd`, and where the caret goes (after
 * the inserted text). A space goes before it when the text before isn't already whitespace or an opening bracket and the
 * transcript doesn't start with punctuation; Whisper's own leading space is dropped. The result is cut to `maxLength`.
 */
export function insertTranscript(
  value: string,
  selStart: number,
  selEnd: number,
  transcript: string,
  maxLength?: number
): { value: string; caret: number } {
  const start = Math.max(0, Math.min(selStart, selEnd, value.length))
  const end = Math.min(value.length, Math.max(selStart, selEnd))
  const before = value.slice(0, start)
  const after = value.slice(end)
  const text = transcript.trim()
  if (text === '') return { value, caret: end > start ? end : start }
  const needsSpace = before !== '' && !/[\s([{]$/.test(before) && !/^[.,;:!?)\]}%]/.test(text)
  let inserted = (needsSpace ? ' ' : '') + text
  if (maxLength !== undefined) inserted = inserted.slice(0, Math.max(0, maxLength - before.length - after.length))
  return { value: before + inserted + after, caret: before.length + inserted.length }
}

/** True when the recording holds no speech: Whisper writes "Thank you." for silence, so such a recording is never transcribed. */
export function isSilent(samples: Float32Array): boolean {
  if (samples.length === 0) return true
  let sum = 0
  for (const s of samples) sum += s * s
  return Math.sqrt(sum / samples.length) < 0.002
}

/** "0:07", "12:30": the time a recording has run. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export type DictationState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'recording' }
  | { kind: 'transcribing' }
  | { kind: 'error'; message: string }

export type DictationEvent =
  | { type: 'start' }
  | { type: 'started' }
  | { type: 'stop' }
  | { type: 'cancel' }
  | { type: 'transcribed' }
  | { type: 'failed'; message: string }
  | { type: 'dismiss' }

export const IDLE: DictationState = { kind: 'idle' }

/** The next state; an event that makes no sense in the current state (a stop while idle) changes nothing. */
export function dictationReducer(state: DictationState, event: DictationEvent): DictationState {
  switch (event.type) {
    case 'start':
      return state.kind === 'idle' || state.kind === 'error' ? { kind: 'starting' } : state
    case 'started':
      return state.kind === 'starting' ? { kind: 'recording' } : state
    case 'stop':
      return state.kind === 'recording' ? { kind: 'transcribing' } : state
    case 'cancel':
      return state.kind === 'starting' || state.kind === 'recording' || state.kind === 'transcribing' ? IDLE : state
    case 'transcribed':
      return state.kind === 'transcribing' ? IDLE : state
    case 'failed':
      return state.kind === 'starting' || state.kind === 'recording' || state.kind === 'transcribing' ? { kind: 'error', message: event.message } : state
    case 'dismiss':
      return state.kind === 'error' ? IDLE : state
  }
}
