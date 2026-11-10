import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement, type RefObject } from 'react'
import { dictationReducer, IDLE, insertTranscript, isSilent, MAX_RECORDING_MS, type DictationEvent, type DictationState } from './dictation'
import { DictationStatus, MicButton } from './MicButton'
import type { Recording } from './types'
import { VoiceError } from './types'
import { useVoice } from './VoiceProvider'

export interface Dictation {
  /** The mic button, for the field's corner. */
  mic: ReactElement
  /** The meter, the time, "Transcribing…" or the error, and the live region: goes under the field. */
  status: ReactElement
  /** Gives the field's key presses a first look. True when it used the key (the field must then do nothing with it). */
  onKeyDown(e: KeyboardEvent<Element>): boolean
}

/**
 * Dictation into one text field: a mic button, Ctrl+Shift+Space, Enter to stop, Esc to cancel. The transcript goes in at the
 * caret (or over the selection) when it arrives, through `setValue`; the field is never sent from here. Null when voice
 * input is off, there is no VoiceProvider around, or the field is disabled or read-only.
 */
export function useDictation({
  inputRef,
  setValue,
  label,
  maxLength,
  disabled = false
}: {
  inputRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null>
  setValue: (value: string) => void
  /** What the field is called, for the button's accessible name. */
  label: string
  maxLength?: number
  disabled?: boolean
}): Dictation | null {
  const voice = useVoice()
  const [state, setState] = useState<DictationState>(IDLE)
  const stateRef = useRef<DictationState>(IDLE)
  const [announcement, setAnnouncement] = useState('')
  const [inserted, setInserted] = useState<{ caret: number; n: number } | null>(null)
  const recording = useRef<Recording | null>(null)
  // Each start gets a number; a cancel (or the field going away) moves it on, so a late answer is dropped.
  const run = useRef(0)
  const release = useRef<(() => void) | null>(null)
  const limit = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The latest of everything the async steps read.
  const level = useRef(() => recording.current?.level() ?? 0)
  const latest = useRef({ voice, setValue, maxLength })
  latest.current = { voice, setValue, maxLength }

  function send(event: DictationEvent): DictationState {
    const next = dictationReducer(stateRef.current, event)
    stateRef.current = next
    setState(next)
    return next
  }

  function finish(): void {
    if (limit.current) clearTimeout(limit.current)
    limit.current = null
    recording.current = null
    release.current?.()
    release.current = null
  }

  function fail(message: string): void {
    finish()
    send({ type: 'failed', message })
    setAnnouncement(message)
  }

  function cancel(): void {
    const kind = stateRef.current.kind
    if (kind !== 'starting' && kind !== 'recording' && kind !== 'transcribing') return
    run.current += 1
    recording.current?.cancel()
    finish()
    send({ type: 'cancel' })
    setAnnouncement('Dictation cancelled.')
  }

  async function start(): Promise<void> {
    const v = latest.current.voice
    if (!v || (stateRef.current.kind !== 'idle' && stateRef.current.kind !== 'error')) return
    if (!v.modelInstalled) {
      v.askDownload()
      return
    }
    const mine = ++run.current
    release.current = v.claim(cancel)
    send({ type: 'start' })
    try {
      const rec = await v.audio.start(v.settings.microphone)
      if (mine !== run.current) {
        rec.cancel()
        return
      }
      recording.current = rec
      send({ type: 'started' })
      setAnnouncement('Recording. Press Enter or the mic button to stop, Escape to cancel.')
      // The model loads while the person speaks; a problem with it shows when the transcript is asked for.
      void v.transcriber.prepare(v.settings.model).catch(() => {})
      limit.current = setTimeout(() => void stop(), MAX_RECORDING_MS)
    } catch (err) {
      if (mine === run.current) fail(err instanceof Error ? err.message : String(err))
    }
  }

  async function stop(): Promise<void> {
    const rec = recording.current
    const v = latest.current.voice
    if (stateRef.current.kind !== 'recording' || !rec || !v) return
    const mine = run.current
    if (limit.current) clearTimeout(limit.current)
    limit.current = null
    send({ type: 'stop' })
    setAnnouncement('Transcribing…')
    try {
      const samples = await rec.stop()
      if (mine !== run.current) return
      recording.current = null
      if (isSilent(samples)) return fail("Didn't hear anything.")
      const text = await v.transcriber.transcribe(samples, { model: v.settings.model, language: v.settings.language })
      if (mine !== run.current) return
      insert(text)
    } catch (err) {
      if (mine === run.current) fail(err instanceof VoiceError || err instanceof Error ? err.message : String(err))
    }
  }

  function insert(text: string): void {
    const box = inputRef.current
    // The field went away while the speech was being turned into text.
    if (!box) return finish()
    const end = box.selectionEnd ?? box.value.length
    const start = box.selectionStart ?? end
    const result = insertTranscript(box.value, start, end, text, latest.current.maxLength)
    if (text.trim() === '') {
      finish()
      send({ type: 'failed', message: "Didn't hear anything." })
      setAnnouncement("Didn't hear anything.")
      return
    }
    latest.current.setValue(result.value)
    setInserted((prev) => ({ caret: result.caret, n: (prev?.n ?? 0) + 1 }))
    finish()
    send({ type: 'transcribed' })
    setAnnouncement('Dictated text inserted.')
  }

  // The caret goes after the inserted text once the new value is in the field, and the field gets focus back.
  useLayoutEffect(() => {
    if (!inserted) return
    const box = inputRef.current
    if (!box) return
    box.focus()
    box.setSelectionRange(inserted.caret, inserted.caret)
    // Only a new insertion moves the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inserted?.n])

  // Esc cancels a dictation in progress, so a dialog or drawer around the field must not close on it (Mantine's convention for that).
  const busy = state.kind === 'starting' || state.kind === 'recording' || state.kind === 'transcribing'
  useEffect(() => {
    const box = inputRef.current
    if (!busy || !box) return
    box.setAttribute('data-mantine-stop-propagation', 'true')
    return () => box.removeAttribute('data-mantine-stop-propagation')
  }, [busy, inputRef])

  // Turning voice input off, or the field going away, ends a dictation in progress.
  const available = voice !== null && voice.settings.enabled && !disabled
  useEffect(() => {
    if (!available) cancel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available])
  useEffect(
    () => () => {
      run.current += 1
      recording.current?.cancel()
      finish()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  function toggle(): void {
    const kind = stateRef.current.kind
    if (kind === 'recording') void stop()
    else if (kind === 'idle' || kind === 'error') void start()
  }

  function onKeyDown(e: KeyboardEvent<Element>): boolean {
    if (!available || e.nativeEvent.isComposing) return false
    const kind = stateRef.current.kind
    const take = (): true => {
      e.preventDefault()
      e.stopPropagation()
      return true
    }
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.code === 'Space' || e.key === ' ')) {
      toggle()
      return take()
    }
    if (kind === 'recording' && e.key === 'Enter') {
      void stop()
      return take()
    }
    if ((kind === 'starting' || kind === 'recording' || kind === 'transcribing') && e.key === 'Escape') {
      cancel()
      return take()
    }
    return false
  }

  if (!available) return null
  return {
    mic: <MicButton state={state} fieldLabel={label} onToggle={toggle} onKeyDown={(e) => void onKeyDown(e)} />,
    status: <DictationStatus state={state} level={level.current} announcement={announcement} />,
    onKeyDown
  }
}
