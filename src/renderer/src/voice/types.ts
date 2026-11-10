import type { VoiceModelId } from '../../../shared/voice'

/** Why a dictation failed, so the message can say what to do about it. */
export type VoiceErrorKind = 'denied' | 'no-device' | 'failed'

export class VoiceError extends Error {
  constructor(
    readonly kind: VoiceErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'VoiceError'
  }
}

/** One recording in progress. The audio lives in memory only: it is handed over by `stop` and never written anywhere. */
export interface Recording {
  /** How loud it is now, 0 to 1, for the meter. */
  level(): number
  /** Ends the recording and gives its audio as 16 kHz mono samples. The microphone is released. */
  stop(): Promise<Float32Array>
  /** Ends the recording and throws the audio away. */
  cancel(): void
}

export interface AudioSource {
  /** Starts recording from the microphone with this device id ('' is the system default). Rejects with a VoiceError. */
  start(deviceId: string): Promise<Recording>
}

export interface Transcriber {
  /** Loads the model so the first transcription is quick. Safe to call again. */
  prepare(model: VoiceModelId): Promise<void>
  /** The text of the speech in 16 kHz mono `audio`. `language` is 'auto' or a Whisper code. */
  transcribe(audio: Float32Array, options: { model: VoiceModelId; language: string }): Promise<string>
  /** Frees the model. */
  dispose(): void
}
