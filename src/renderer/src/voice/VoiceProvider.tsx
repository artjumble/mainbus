import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { VOICE_DEFAULTS, VOICE_MODELS, type VoiceModelStatus, type VoiceSettings } from '../../../shared/voice'
import { invoke, onEngineEvent } from '../api'
import { showError } from '../notify'
import { FakeTranscriber, fakeVoiceRequested } from './fakeVoice'
import { micAudioSource } from './micAudioSource'
import { ModelDownloadModal } from './ModelDownloadModal'
import type { AudioSource, Transcriber } from './types'
import { WhisperTranscriber } from './whisperTranscriber'

/** What a field needs to dictate. Without a provider around it a field has no mic button. */
export interface VoiceContextValue {
  settings: VoiceSettings
  /** Whether the chosen model is on disk (always true with the fake transcriber). */
  modelInstalled: boolean
  audio: AudioSource
  transcriber: Transcriber
  /** Opens the dialog that asks whether to download the chosen model. */
  askDownload(): void
  /** Makes `cancel` the one dictation in progress: the one before it is cancelled. Returns the call that lets go of it. */
  claim(cancel: () => void): () => void
}

export const VoiceContext = createContext<VoiceContextValue | null>(null)

export function useVoice(): VoiceContextValue | null {
  return useContext(VoiceContext)
}

/**
 * Holds the Voice input setting, the state of the models and the one transcriber, and offers them to every field with a
 * mic button. Also owns the dialog that asks before a model is downloaded. `audio` and `transcriber` are for tests.
 */
export function VoiceProvider({
  children,
  audio = micAudioSource,
  transcriber: injected
}: {
  children: ReactNode
  audio?: AudioSource
  transcriber?: Transcriber
}): ReactElement {
  const fake = useMemo(() => fakeVoiceRequested(), [])
  const [settings, setSettings] = useState<VoiceSettings>(VOICE_DEFAULTS)
  const [models, setModels] = useState<VoiceModelStatus[]>([])
  const [asking, setAsking] = useState(false)
  const transcriber = useMemo<Transcriber>(() => injected ?? (fake ? new FakeTranscriber() : new WhisperTranscriber()), [injected, fake])
  const active = useRef<(() => void) | null>(null)

  useEffect(() => {
    let alive = true
    invoke('settings.get')
      .then((s) => alive && s?.voice && setSettings(s.voice))
      .catch((err: unknown) => showError(err, 'Could not read the voice input setting'))
    invoke('voice.models')
      .then((m) => alive && Array.isArray(m) && setModels(m))
      .catch(() => {})
    const off = onEngineEvent((e) => {
      if (e.type === 'voice.changed') setSettings(e.voice)
      if (e.type === 'voice.models') setModels(e.models)
    })
    return () => {
      alive = false
      off?.()
    }
  }, [])

  // Turning voice input off, or choosing another model, frees the loaded one.
  useEffect(() => {
    if (!settings.enabled) transcriber.dispose()
  }, [settings.enabled, transcriber])
  const lastModel = useRef(settings.model)
  useEffect(() => {
    if (lastModel.current !== settings.model) transcriber.dispose()
    lastModel.current = settings.model
  }, [settings.model, transcriber])

  const claim = useCallback((cancel: () => void) => {
    const previous = active.current
    active.current = cancel
    if (previous && previous !== cancel) previous()
    return () => {
      if (active.current === cancel) active.current = null
    }
  }, [])
  const askDownload = useCallback(() => setAsking(true), [])
  const status = models.find((m) => m.id === settings.model)
  const modelInstalled = fake || status?.installed === true

  const value = useMemo<VoiceContextValue>(
    () => ({ settings, modelInstalled, audio, transcriber, askDownload, claim }),
    [settings, modelInstalled, audio, transcriber, askDownload, claim]
  )

  const spec = VOICE_MODELS.find((m) => m.id === settings.model) ?? VOICE_MODELS[0]!
  return (
    <VoiceContext.Provider value={value}>
      {children}
      <ModelDownloadModal
        opened={asking}
        model={spec}
        status={status}
        onClose={() => setAsking(false)}
        onDownload={() => void invoke('voice.downloadModel', spec.id).catch((err: unknown) => showError(err, 'Could not download the voice model'))}
        onCancel={() => void invoke('voice.cancelDownload', spec.id).catch(() => {})}
      />
    </VoiceContext.Provider>
  )
}
