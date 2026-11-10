// Runs Whisper in a Web Worker so the page never freezes. It loads the model files the app downloaded, through the
// mainbus-model:// scheme, and never fetches anything else: the page's content security policy lists no remote host,
// so even a bug here could not send audio anywhere. Imported only through whisperTranscriber's dynamic import.
import { env, pipeline } from '@huggingface/transformers'
import wasmFactoryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import type { WorkerRequest, WorkerResponse } from './whisperMessages'

// What this worker needs of its global scope; the project's TypeScript sees the DOM, not the worker, library.
const scope = self as unknown as {
  postMessage(message: WorkerResponse): void
  addEventListener(type: 'message', listener: (e: MessageEvent<WorkerRequest>) => void): void
}

env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = 'mainbus-model://models/'
env.useBrowserCache = false
env.useWasmCache = false
// The default is a CDN, which the page's policy blocks. These are the copies bundled with the app.
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } }
if (onnx.wasm) {
  onnx.wasm.wasmPaths = { mjs: new URL(wasmFactoryUrl, self.location.href).href, wasm: new URL(wasmUrl, self.location.href).href }
  onnx.wasm.numThreads = 1
}

type Asr = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>
let loaded: { model: string; asr: Promise<Asr> } | null = null

async function hasWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    return gpu !== undefined && (await gpu.requestAdapter()) !== null
  } catch {
    return false
  }
}

function load(model: string): { asr: Promise<Asr> } {
  if (loaded?.model === model) return loaded
  const asr = (async (): Promise<Asr> => {
    const useGpu = await hasWebGpu()
    const make = (d: 'webgpu' | 'wasm'): Promise<Asr> =>
      pipeline('automatic-speech-recognition', model, {
        device: d,
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }
      }) as unknown as Promise<Asr>
    if (!useGpu) return make('wasm')
    // A GPU that is there but fails to run the model is not a failure: the CPU does it.
    return make('webgpu').catch(() => make('wasm'))
  })()
  loaded = { model, asr }
  asr.catch(() => {
    if (loaded?.asr === asr) loaded = null
  })
  return loaded
}

scope.addEventListener('message', (e) => {
  const msg = e.data
  void (async () => {
    try {
      const asr = await load(msg.model).asr
      if (msg.type === 'prepare') {
        scope.postMessage({ type: 'ready', id: msg.id })
        return
      }
      const out = await asr(msg.audio, {
        task: 'transcribe',
        // Whisper in transformers.js has no language detection: with no language chosen it speaks English.
        language: msg.language === 'auto' ? 'en' : msg.language,
        chunk_length_s: 30,
        stride_length_s: 5
      })
      const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim()
      scope.postMessage({ type: 'result', id: msg.id, text })
    } catch (err) {
      scope.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) })
    }
  })()
})
