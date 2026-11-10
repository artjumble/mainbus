import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { EngineEvent } from '../../shared/api'
import { voiceModelSourceUrl, type VoiceModelId, type VoiceModelSpec, type VoiceModelStatus } from '../../shared/voice'

export interface VoiceModels {
  statuses(): Promise<VoiceModelStatus[]>
  /** Downloads and checks every file of the model into its folder; resolves once it is installed. Nothing else in the app fetches. */
  download(id: VoiceModelId): Promise<VoiceModelStatus[]>
  cancel(id: VoiceModelId): Promise<VoiceModelStatus[]>
  remove(id: VoiceModelId): Promise<VoiceModelStatus[]>
}

export interface VoiceModelsDeps {
  /** The `models` folder of the data home. */
  dir: string
  fetch: typeof fetch
  manifest: VoiceModelSpec[]
  emit: (e: EngineEvent) => void
  /** The shortest time between two progress events, ms. */
  throttleMs?: number
}

/** The folder a model is installed in. */
export const voiceModelFolder = (dir: string, id: VoiceModelId): string => path.join(dir, id)

export function createVoiceModels(deps: VoiceModelsDeps): VoiceModels {
  const { dir, manifest, emit } = deps
  const throttleMs = deps.throttleMs ?? 250
  const active = new Map<VoiceModelId, { loaded: number; total: number; abort: AbortController }>()
  const errors = new Map<VoiceModelId, string>()
  const spec = (id: VoiceModelId): VoiceModelSpec => {
    const found = manifest.find((m) => m.id === id)
    if (!found) throw new Error(`Unknown voice model ${String(id)}`)
    return found
  }
  const partialFolder = (id: VoiceModelId): string => path.join(dir, `.partial-${id}`)

  async function installed(m: VoiceModelSpec): Promise<boolean> {
    try {
      for (const f of m.files) {
        const st = await fs.promises.stat(path.join(voiceModelFolder(dir, m.id), f.path))
        if (!st.isFile() || st.size !== f.size) return false
      }
      return true
    } catch {
      return false
    }
  }

  async function statuses(): Promise<VoiceModelStatus[]> {
    return Promise.all(
      manifest.map(async (m) => {
        const a = active.get(m.id)
        return {
          id: m.id,
          installed: await installed(m),
          download: a ? { loaded: a.loaded, total: a.total } : null,
          error: errors.get(m.id) ?? null
        }
      })
    )
  }

  let lastEmit = 0
  async function publish(force: boolean): Promise<void> {
    const t = Date.now()
    if (!force && t - lastEmit < throttleMs) return
    lastEmit = t
    emit({ type: 'voice.models', models: await statuses() })
  }

  async function fetchFile(m: VoiceModelSpec, file: VoiceModelSpec['files'][number], folder: string, state: { loaded: number; abort: AbortController }): Promise<void> {
    const url = voiceModelSourceUrl(m, file.path)
    const res = await deps.fetch(url, { signal: state.abort.signal, redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`Couldn't download ${file.path}: ${res.status} ${res.statusText}`.trim())
    const target = path.join(folder, file.path)
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    const hash = createHash('sha256')
    let size = 0
    const out = fs.createWriteStream(target)
    try {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        hash.update(value)
        state.loaded += value.byteLength
        if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', resolve))
        void publish(false)
      }
    } finally {
      await new Promise<void>((resolve) => out.end(resolve))
    }
    if (size !== file.size) throw new Error(`${file.path} is ${size} bytes, expected ${file.size}`)
    if (hash.digest('hex') !== file.sha256) throw new Error(`${file.path} doesn't match its checksum`)
  }

  return {
    statuses,
    async download(id) {
      const m = spec(id)
      if (active.has(id)) return statuses()
      if (await installed(m)) return statuses()
      const abort = new AbortController()
      const state = { loaded: 0, total: m.files.reduce((s, f) => s + f.size, 0), abort }
      active.set(id, state)
      errors.delete(id)
      const partial = partialFolder(id)
      await fs.promises.rm(partial, { recursive: true, force: true })
      try {
        await publish(true)
        for (const file of m.files) await fetchFile(m, file, partial, state)
        await fs.promises.rm(voiceModelFolder(dir, id), { recursive: true, force: true })
        await fs.promises.rename(partial, voiceModelFolder(dir, id))
      } catch (err) {
        await fs.promises.rm(partial, { recursive: true, force: true })
        // A cancel is not an error.
        if (!abort.signal.aborted) errors.set(id, err instanceof Error ? err.message : String(err))
      } finally {
        active.delete(id)
      }
      await publish(true)
      return statuses()
    },
    async cancel(id) {
      spec(id)
      active.get(id)?.abort.abort()
      return statuses()
    },
    async remove(id) {
      spec(id)
      active.get(id)?.abort.abort()
      await fs.promises.rm(voiceModelFolder(dir, id), { recursive: true, force: true })
      errors.delete(id)
      await publish(true)
      return statuses()
    }
  }
}
