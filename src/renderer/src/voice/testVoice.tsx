import { act, type RenderResult } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { EngineEvent } from '../../../shared/api'
import { VOICE_DEFAULTS, type VoiceModelStatus, type VoiceSettings } from '../../../shared/voice'
import { invoke, onEngineEvent } from '../api'
import { renderWithMantine } from '../test-utils'
import { FakeAudioSource, FakeTranscriber } from './fakeVoice'
import { VoiceProvider } from './VoiceProvider'

/**
 * For tests that mock `../api` (`vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), ... }))`): renders `ui` inside the
 * real VoiceProvider with a fake audio source and transcriber, and the settings and model state the engine would give.
 */
export function renderWithVoice(
  ui: ReactElement,
  options: {
    voice?: Partial<VoiceSettings>
    models?: VoiceModelStatus[]
    audio?: FakeAudioSource
    transcriber?: FakeTranscriber
    /** Answers for any other command the component under test sends. */
    respond?: (command: string, ...args: unknown[]) => unknown
  } = {}
): RenderResult & { audio: FakeAudioSource; transcriber: FakeTranscriber; emit: (e: EngineEvent) => void } {
  const audio = options.audio ?? new FakeAudioSource()
  const transcriber = options.transcriber ?? new FakeTranscriber('This was dictated.', 0)
  const voice = { ...VOICE_DEFAULTS, ...options.voice }
  const models = options.models ?? [{ id: voice.model, installed: true, download: null, error: null }]
  const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'settings.get') return { voice }
    if (command === 'voice.models') return models
    return options.respond?.(command, ...args)
  })
  const listeners: ((e: EngineEvent) => void)[] = []
  ;(onEngineEvent as unknown as ReturnType<typeof vi.fn>).mockImplementation((l: (e: EngineEvent) => void) => {
    listeners.push(l)
    return () => {}
  })
  const result = renderWithMantine(
    <VoiceProvider audio={audio} transcriber={transcriber}>
      {ui}
    </VoiceProvider>
  )
  const emit = (e: EngineEvent): void => act(() => listeners.forEach((l) => l(e)))
  return Object.assign(result, { audio, transcriber, emit })
}
