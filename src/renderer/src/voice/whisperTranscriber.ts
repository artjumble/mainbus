import type { VoiceModelId } from '../../../shared/voice'
import type { Transcriber } from './types'
import type { WorkerRequest, WorkerResponse } from './whisperMessages'

/**
 * The real transcriber: Whisper in a module Web Worker, started on first use and kept so the model stays loaded.
 * The worker (and with it transformers.js and the runtime) is its own chunk, loaded only when someone dictates.
 */
export class WhisperTranscriber implements Transcriber {
  private worker: Worker | null = null
  private nextId = 1
  private readonly waiting = new Map<number, { resolve: (text: string) => void; reject: (err: Error) => void }>()

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const w = this.waiting.get(e.data.id)
      if (!w) return
      this.waiting.delete(e.data.id)
      if (e.data.type === 'error') w.reject(new Error(e.data.message))
      else w.resolve(e.data.type === 'result' ? e.data.text : '')
    }
    worker.onerror = (e) => this.fail(new Error(e.message || 'The speech worker stopped'))
    this.worker = worker
    return worker
  }

  private fail(err: Error): void {
    for (const w of this.waiting.values()) w.reject(err)
    this.waiting.clear()
    this.worker?.terminate()
    this.worker = null
  }

  private ask(request: (id: number) => WorkerRequest, transfer: Transferable[] = []): Promise<string> {
    const worker = this.ensureWorker()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      worker.postMessage(request(id), transfer)
    })
  }

  async prepare(model: VoiceModelId): Promise<void> {
    await this.ask((id) => ({ type: 'prepare', id, model }))
  }

  transcribe(audio: Float32Array, options: { model: VoiceModelId; language: string }): Promise<string> {
    return this.ask((id) => ({ type: 'transcribe', id, model: options.model, language: options.language, audio }), [audio.buffer])
  }

  dispose(): void {
    this.fail(new Error('Voice input was turned off'))
  }
}
