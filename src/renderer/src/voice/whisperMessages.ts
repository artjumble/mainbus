/** What the page sends the speech worker, and what it answers. Each answer carries the id of its request. */
export type WorkerRequest =
  | { type: 'prepare'; id: number; model: string }
  | { type: 'transcribe'; id: number; model: string; language: string; audio: Float32Array }

export type WorkerResponse = { type: 'ready'; id: number } | { type: 'result'; id: number; text: string } | { type: 'error'; id: number; message: string }
