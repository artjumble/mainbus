import type { VoiceModelId } from '../../../shared/voice'
import { VoiceError, type AudioSource, type Recording, type Transcriber } from './types'

/** The sentence the fake transcriber always hears. */
export const FAKE_SENTENCE = 'This was dictated.'

/** True when the page was opened for an end-to-end test (`?voice=fake`): it dictates with fakes and never needs a model. */
export function fakeVoiceRequested(search: string = globalThis.location?.search ?? ''): boolean {
  return new URLSearchParams(search).get('voice') === 'fake'
}

/** Returns a fixed sentence after a short wait, and fails on empty audio. Used by tests and the fake voice mode. */
export class FakeTranscriber implements Transcriber {
  readonly calls: { samples: number; model: VoiceModelId; language: string }[] = []
  prepared: VoiceModelId[] = []
  disposed = false

  constructor(
    private readonly sentence: string = FAKE_SENTENCE,
    private readonly delayMs = 200
  ) {}

  async prepare(model: VoiceModelId): Promise<void> {
    this.prepared.push(model)
  }

  async transcribe(audio: Float32Array, options: { model: VoiceModelId; language: string }): Promise<string> {
    this.calls.push({ samples: audio.length, ...options })
    if (audio.length === 0) throw new Error('No audio')
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
    return this.sentence
  }

  dispose(): void {
    this.disposed = true
  }
}

/**
 * A scripted audio source: each recording reports `levels` in turn, then its last, and stops with `samples`. With
 * `error`, starting rejects with it. `started`, `stopped` and `cancelled` count what was done to it.
 */
export class FakeAudioSource implements AudioSource {
  started: string[] = []
  stopped = 0
  cancelled = 0

  constructor(
    private readonly options: { levels?: number[]; samples?: Float32Array; error?: VoiceError } = {}
  ) {}

  async start(deviceId: string): Promise<Recording> {
    this.started.push(deviceId)
    if (this.options.error) throw this.options.error
    const levels = this.options.levels ?? [0.4]
    let i = 0
    return {
      level: () => levels[Math.min(i++, levels.length - 1)] ?? 0,
      stop: async () => {
        this.stopped += 1
        return this.options.samples ?? new Float32Array(16000).fill(0.1)
      },
      cancel: () => {
        this.cancelled += 1
      }
    }
  }
}
