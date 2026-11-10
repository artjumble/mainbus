import { VoiceError, type AudioSource, type Recording } from './types'

const SAMPLE_RATE = 16000

/** The message for each way the microphone can fail; what the field shows. */
export function microphoneError(err: unknown): VoiceError {
  const name = err instanceof Error || err instanceof DOMException ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new VoiceError(
      'denied',
      "Mainbus can't use the microphone. In Windows Settings → Privacy & security → Microphone, let desktop apps use it."
    )
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return new VoiceError('no-device', 'No microphone found. Connect one, or choose another in Mainbus settings → Voice input.')
  }
  return new VoiceError('failed', `The microphone could not be used${err instanceof Error && err.message ? `: ${err.message}` : '.'}`)
}

/**
 * Records from the microphone into memory. The chunks are decoded to 16 kHz mono samples when the recording stops;
 * every track is stopped, the audio context closed and the chunks dropped, so the microphone light goes off and nothing is kept.
 */
export const micAudioSource: AudioSource = {
  async start(deviceId) {
    const open = (id: string): Promise<MediaStream> =>
      navigator.mediaDevices.getUserMedia({
        audio: { ...(id ? { deviceId: { exact: id } } : {}), channelCount: 1, echoCancellation: true, noiseSuppression: true }
      })
    let stream: MediaStream
    try {
      // A saved microphone that is no longer connected falls back to the system default.
      stream = await open(deviceId).catch((err: unknown) => {
        if (deviceId !== '' && err instanceof DOMException && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) return open('')
        throw err
      })
    } catch (err) {
      throw microphoneError(err)
    }
    let meterContext: AudioContext | null = null
    let analyser: AnalyserNode | null = null
    let chunks: Blob[] = []
    let recorder: MediaRecorder
    try {
      meterContext = new AudioContext()
      analyser = meterContext.createAnalyser()
      analyser.fftSize = 512
      meterContext.createMediaStreamSource(stream).connect(analyser)
      recorder = new MediaRecorder(stream)
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      recorder.start()
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop())
      void meterContext?.close()
      throw microphoneError(err)
    }
    const samples = new Uint8Array(analyser.fftSize)
    const release = (): void => {
      stream.getTracks().forEach((t) => t.stop())
      void meterContext?.close().catch(() => {})
    }
    const finish = (): Promise<Blob> =>
      new Promise((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }))
        if (recorder.state === 'inactive') recorder.onstop(new Event('stop'))
        else recorder.stop()
      })
    const recording: Recording = {
      level() {
        analyser!.getByteTimeDomainData(samples)
        let sum = 0
        for (const s of samples) sum += ((s - 128) / 128) ** 2
        return Math.min(1, Math.sqrt(sum / samples.length) * 3)
      },
      async stop() {
        const blob = await finish()
        release()
        chunks = []
        const decodeContext = new AudioContext({ sampleRate: SAMPLE_RATE })
        try {
          const decoded = await decodeContext.decodeAudioData(await blob.arrayBuffer())
          return decoded.getChannelData(0).slice()
        } catch (err) {
          throw new VoiceError('failed', `The recording could not be read${err instanceof Error ? `: ${err.message}` : '.'}`)
        } finally {
          void decodeContext.close().catch(() => {})
        }
      },
      cancel() {
        recorder.ondataavailable = null
        recorder.onstop = null
        if (recorder.state !== 'inactive') recorder.stop()
        release()
        chunks = []
      }
    }
    return recording
  }
}
